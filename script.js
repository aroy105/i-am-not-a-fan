import puppeteer from "puppeteer";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function uniq(arr) {
  return Array.from(new Set(arr));
}

function diff(a, b) {
  const B = new Set(b);
  return a.filter((x) => !B.has(x));
}

async function humanClick(page, selector) {
  await page.waitForSelector(selector, { visible: true });
  await sleep(jitter(250, 700));

  const el = await page.$(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  const box = await el.boundingBox();
  if (!box) throw new Error(`No bounding box: ${selector}`);

  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);

  await page.mouse.move(x, y, { steps: jitter(12, 28) });
  await sleep(jitter(80, 220));
  await page.mouse.click(x, y);
  await sleep(jitter(200, 500));
}

async function waitForListView(page) {
  await page.waitForFunction(() => {
    const inDialog = document.querySelector('[role="dialog"]') || document.body;
    const links = Array.from(inDialog.querySelectorAll('a[role="link"][href^="/"]'));
    return links.some((a) => /^\/[^\/]+\/$/.test(a.getAttribute("href") || ""));
  }, { timeout: 20000 });
}

async function getDialogAndScrollSelector(page) {
  await waitForListView(page);

  const res = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { hasDialog: false, scrollSelector: null };

    const candidates = Array.from(dialog.querySelectorAll("*"))
      .filter((el) => {
        const s = window.getComputedStyle(el);
        const oy = s.overflowY;
        if (!(oy === "auto" || oy === "scroll")) return false;
        return el.scrollHeight > el.clientHeight + 5;
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

    const target = candidates[0];
    if (!target) return { hasDialog: true, scrollSelector: null };

    if (!target.dataset) target.dataset = {};
    target.dataset.pupScroll = "1";

    return { hasDialog: true, scrollSelector: '[data-pup-scroll="1"]' };
  });

  if (!res.hasDialog) return { dialogSelector: null, scrollSelector: null };
  return { dialogSelector: '[role="dialog"]', scrollSelector: res.scrollSelector };
}

async function wheelScrollContainerToEnd(page, scrollSelector) {
  await page.waitForSelector(scrollSelector, { visible: true });

  const el = await page.$(scrollSelector);
  const box = await el.boundingBox();
  if (!box) throw new Error("Scroll container has no bounding box.");

  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.5;

  await page.mouse.move(x, y, { steps: jitter(10, 18) });
  await sleep(jitter(120, 260));

  const getState = async () => {
    return await page.evaluate((scrollSel) => {
      const scroller = document.querySelector(scrollSel);
      const dialog = document.querySelector('[role="dialog"]');
      const scope = dialog || document.body;

      const hrefs = Array.from(scope.querySelectorAll('a[role="link"][href^="/"]'))
        .map((a) => a.getAttribute("href"))
        .filter((h) => /^\/[^\/]+\/$/.test(h || ""));

      const uniqueCount = new Set(hrefs).size;

      const atBottom = scroller
        ? (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4)
        : false;

      return {
        uniqueCount,
        atBottom,
        scrollTop: scroller ? scroller.scrollTop : 0,
        scrollHeight: scroller ? scroller.scrollHeight : 0,
        clientHeight: scroller ? scroller.clientHeight : 0
      };
    }, scrollSelector);
  };

  let lastCount = -1;
  let lastChangeTs = Date.now();

  const QUIET_MS = 1600;
  const MAX_STEPS = 360;

  for (let i = 0; i < MAX_STEPS; i++) {
    await page.mouse.wheel({ deltaY: Math.floor(box.height * (1.0 + Math.random() * 0.8)) });
    await sleep(160);

    const s1 = await getState();
    if (s1.uniqueCount !== lastCount) {
      lastCount = s1.uniqueCount;
      lastChangeTs = Date.now();
    }

    if (s1.atBottom) {
      await sleep(450);
      const s2 = await getState();
      if (s2.uniqueCount !== lastCount) {
        lastCount = s2.uniqueCount;
        lastChangeTs = Date.now();
      }

      const quiet = Date.now() - lastChangeTs;
      if (quiet >= QUIET_MS && i > 25) break;
    }

    if (i > 0 && i % 22 === 0) await sleep(240);
  }
}


async function scrapeUsernamesFromDialog(page) {
  await waitForListView(page);

  return await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const scope = dialog || document.body;

    const hrefs = Array.from(scope.querySelectorAll('a[role="link"][href^="/"]'))
      .map((a) => a.getAttribute("href"))
      .filter((h) => /^\/[^\/]+\/$/.test(h || ""));

    return Array.from(new Set(hrefs.map((h) => h.replaceAll("/", ""))));
  });
}

async function closeDialog(page) {
  await page.keyboard.press("Escape");
  await sleep(jitter(250, 500));
}

async function collectList(page, href) {
  const selector = `a[href="${href}"][role="link"]`;
  await humanClick(page, selector);

  await waitForListView(page);

  const { scrollSelector } = await getDialogAndScrollSelector(page);
  await wheelScrollContainerToEnd(page, scrollSelector);

  const names = await scrapeUsernamesFromDialog(page);
  await closeDialog(page);

  return uniq(names);
}

(async () => {
  const userId = "";
  const baseUrl = "";
  const profileUrl = `${baseUrl}/${userId}/`;

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: "./profile",
    defaultViewport: null,
    args: ["--start-maximized"]
  });

  const page = await browser.newPage();
  await page.goto(profileUrl, { waitUntil: "networkidle2" });
  await sleep(jitter(700, 1400));

  const followersHref = `/${userId}/followers/`;
  const followingHref = `/${userId}/following/`;

  const followers = await collectList(page, followersHref);
  await sleep(jitter(500, 900));

  const following = await collectList(page, followingHref);

  const notFollowingYou = diff(following, followers);

  console.log(JSON.stringify({
    counts: { followers: followers.length, following: following.length },
    notFollowingYou
  }, null, 2));
})();
