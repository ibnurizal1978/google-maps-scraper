import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import readline from 'readline';

// CONFIGURATION
const CONCURRENCY_LIMIT = 5; // Scrape 5 businesses at the same time
const VIEWPORT = { width: 1366, height: 768 };

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function extractEmail(text) {
    if (!text) return null;
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const match = text.match(emailPattern);
    return match ? match[0] : null;
}

async function scrapeBusinessDetails(browser, url, index) {
    const page = await browser.newPage();
    try {
        console.log(`   [Worker] Opening details for item #${index}...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait for main headline to ensure page loaded
        try {
            await page.waitForSelector('h1', { timeout: 10000 });
        } catch (e) {
            // Continue even if h1 not found immediately
        }

        const data = {
            name: '',
            phone: '',
            website: '',
            address: '',
            email: '',
            url: url
        };

        // 1. Get Name
        try {
            data.name = await page.locator('h1').innerText();
        } catch (e) { data.name = 'Unknown'; }

        // 2. Get Phone (Look for aria-labels or specific icons)
        try {
            const phoneBtn = page.locator('button[data-item-id^="phone:tel:"]');
            if (await phoneBtn.count() > 0) {
                data.phone = await phoneBtn.first().getAttribute('aria-label');
                if (data.phone) data.phone = data.phone.replace('Phone: ', '').strip();
            } else {
                // Fallback: look for button with phone icon
                const altPhone = page.locator('button[aria-label*="Phone"]');
                if (await altPhone.count() > 0) {
                    data.phone = await altPhone.first().getAttribute('aria-label');
                    data.phone = data.phone.replace('Phone: ', '').trim();
                }
            }
        } catch (e) { }

        // 3. Get Website
        try {
            const websiteBtn = page.locator('a[data-item-id="authority"]');
            if (await websiteBtn.count() > 0) {
                data.website = await websiteBtn.first().getAttribute('href');
            } else {
                const altWeb = page.locator('a[aria-label*="Website"]');
                if (await altWeb.count() > 0) {
                    data.website = await altWeb.first().getAttribute('href');
                }
            }
        } catch (e) { }

        // 4. Get Address
        try {
            const addrBtn = page.locator('button[data-item-id="address"]');
            if (await addrBtn.count() > 0) {
                data.address = await addrBtn.first().getAttribute('aria-label');
                data.address = data.address.replace('Address: ', '').trim();
            }
        } catch (e) { }

        // 5. Extract Email from Website (Advanced)
        if (data.website) {
            try {
                // console.log(`      Visiting website for email: ${data.website}`);
                // Navigate to the website with a short timeout to avoid getting stuck
                await page.goto(data.website, { waitUntil: 'domcontentloaded', timeout: 15000 });

                const content = await page.content();
                const email = await extractEmail(content);

                if (email) {
                    data.email = email;
                    // Check for contact page if not found on home? (Optional optimization)
                }
            } catch (e) {
                // Ignore website errors (timeout, ssl error, etc)
                // console.log(`      Could not access website: ${e.message}`);
            }
        }

        console.log(`   ✓ Scraped: ${data.name} ${data.email ? `📧 ${data.email}` : ''}`);
        return data;

    } catch (error) {
        console.log(`   ✗ Error processing item #${index}: ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

async function main() {
    console.log("===========================================");
    console.log("   GOOGLE MAPS SCRAPER - NODE.JS TURBO 🚀");
    console.log("===========================================");

    const query = await askQuestion("Enter search query (e.g. 'coffee shop jakarta'): ");
    //const maxStr = await askQuestion("Max results (default 20): ");
    const maxStr = 1000;
    const maxResults = parseInt(maxStr) || 1000;

    rl.close();

    console.log(`\n🚀 Launching browser...`);
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    try {
        console.log(`📍 Navigating to Google Maps...`);
        await page.goto('https://www.google.com/maps', { timeout: 60000 });

        console.log(`🔍 Searching for "${query}"...`);
        const searchBox = await page.waitForSelector('input#searchboxinput');
        await searchBox.fill(query);
        await searchBox.press('Enter');

        // Wait for results panel
        console.log(`Waiting for results...`);
        const feedSelector = 'div[role="feed"]';
        try {
            await page.waitForSelector(feedSelector, { timeout: 15000 });
        } catch (e) {
            console.log("Could not find results feed. Ensure the search has results.");
            await browser.close();
            return;
        }

        // --- SCROLLING PHASE ---
        console.log(`📜 Scrolling to load ${maxResults} items...`);
        let previouslyCount = 0;
        let links = new Set();

        const feed = page.locator(feedSelector);

        while (links.size < maxResults) {
            // Get all current links
            const anchors = await feed.locator('a[href^="https://www.google.com/maps/place"]').all();

            for (const anchor of anchors) {
                const href = await anchor.getAttribute('href');
                if (href) links.add(href);
            }

            if (links.size >= maxResults) break;

            // Check if we are stuck
            if (anchors.length === previouslyCount) {
                // Try waiting a bit longer or verifying if end of list
                await page.waitForTimeout(2000);
                const newAnchors = await feed.locator('a[href^="https://www.google.com/maps/place"]').count();
                if (newAnchors === previouslyCount) {
                    console.log("   Ended of list reached or stuck.");
                    break;
                }
            }
            previouslyCount = anchors.length;

            // Scroll down
            await feed.evaluate(node => node.scrollTo(0, node.scrollHeight));
            process.stdout.write(`   Collected ${links.size} / ${maxResults} links...\r`);
            await page.waitForTimeout(1000);
        }

        console.log(`\n\n✅ Collected ${links.size} unique business links. Starting parallel scraping...`);

        // --- PARALLEL SCRAPING PHASE ---
        const linksArray = Array.from(links).slice(0, maxResults);
        const results = [];

        // Split into chunks for rate limiting (Concurrency Control)
        for (let i = 0; i < linksArray.length; i += CONCURRENCY_LIMIT) {
            const chunk = linksArray.slice(i, i + CONCURRENCY_LIMIT);
            console.log(`\nProcessing Batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1} (${chunk.length} items)...`);

            // Map chunk to promises
            const promises = chunk.map((url, idx) => scrapeBusinessDetails(browser, url, i + idx + 1));

            // Wait for all in this batch to finish
            const batchResults = await Promise.all(promises);
            results.push(...batchResults.filter(r => r !== null));
        }

        // --- SAVING TO EXCEL ---
        if (results.length > 0) {
            console.log(`\n💾 Saving ${results.length} results to Excel...`);
            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet('Scraping Results');

            sheet.columns = [
                { header: 'Name', key: 'name', width: 30 },
                { header: 'Phone', key: 'phone', width: 20 },
                { header: 'Email', key: 'email', width: 25 },
                { header: 'Address', key: 'address', width: 40 },
                { header: 'Website', key: 'website', width: 40 },
                { header: 'Map URL', key: 'url', width: 50 },
            ];

            sheet.addRows(results);

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `gmaps_results_${query}.xlsx`;

            await workbook.xlsx.writeFile(filename);
            console.log(`🎉 Done! File saved as: ${filename}`);
        } else {
            console.log("\n⚠️ No results extracted.");
        }

    } catch (e) {
        console.error("Fatal Error:", e);
    } finally {
        await browser.close();
    }
}

main();
