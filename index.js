import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import path from 'path';
import fs from 'fs';

const fastify = Fastify({ logger: false });
const PORT = 3000;

// Configuration Scraper
const CONCURRENCY_LIMIT = 5;
const VIEWPORT = { width: 1366, height: 768 };

// Extract Email
async function extractEmail(text) {
    if (!text) return null;
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const match = text.match(emailPattern);
    return match ? match[0] : null;
}

// Scrape function
async function scrapeBusinessDetails(browser, url, index) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const data = { name: 'Unknown', phone: '', website: '', address: '', email: '', url: url };

        try { data.name = await page.locator('h1').innerText(); } catch (e) { }

        try {
            const phoneBtn = page.locator('button[data-item-id^="phone:tel:"]');
            if (await phoneBtn.count() > 0) {
                data.phone = (await phoneBtn.first().getAttribute('aria-label')).replace('Phone: ', '').trim();
            }
        } catch (e) { }

        try {
            const websiteBtn = page.locator('a[data-item-id="authority"]');
            if (await websiteBtn.count() > 0) {
                data.website = await websiteBtn.first().getAttribute('href');
            }
        } catch (e) { }

        try {
            const addrBtn = page.locator('button[data-item-id="address"]');
            if (await addrBtn.count() > 0) {
                data.address = (await addrBtn.first().getAttribute('aria-label')).replace('Address: ', '').trim();
            }
        } catch (e) { }

        if (data.website) {
            try {
                await page.goto(data.website, { waitUntil: 'domcontentloaded', timeout: 10000 });
                data.email = await extractEmail(await page.content()) || '';
            } catch (e) { }
        }

        return data;
    } catch (error) {
        return null;
    } finally {
        await page.close();
    }
}

// UI Section, use simple bootstrap lah...
const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
    <title>Google Maps Scraper - Rizal</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background: #f8f9fa; padding: 50px; }
        .container { max-width: 600px; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        #status { margin-top: 20px; font-weight: bold; color: #0d6efd; }
    </style>
</head>
<body>
    <div class="container">
        <h2 class="mb-4">Google Maps Scraper - Rizal</h2>
        <form id="scrapeForm">
            <div class="mb-3">
                <label class="form-label">Search Query</label>
                <input type="text" name="query" class="form-control" placeholder="e.g. Coffee Shop Jakarta" required>
            </div>
            <p>For this time, I limit to 20 results</p>
            <button type="submit" id="btnSubmit" class="btn btn-primary w-100">Start</button>
        </form>
        <div id="status"></div>
    </div>

    <script>
        const form = document.getElementById('scrapeForm');
        const status = document.getElementById('status');
        const btn = document.getElementById('btnSubmit');

        form.onsubmit = async (e) => {
            e.preventDefault();
            const formData = new FormData(form);
            const query = formData.get('query');
            const limit = formData.get('limit');

            btn.disabled = true;
            status.innerText = "Scraping...please wait and do not close this browser.";

            try {
                const response = await fetch('/scrape', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ query, limit })
                });

                if (response.ok) {
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = "results_" + query.replace(/\\s+/g, '_') + ".xlsx";
                    document.body.appendChild(a);
                    a.click();
                    status.innerText = "Done! File downloaded.";
                } else {
                    status.innerText = "Oopps, an error occured. Check log.";
                }
            } catch (err) {
                status.innerText = "Error: " + err.message;
            } finally {
                btn.disabled = false;
            }
        };
    </script>
</body>
</html>
`;

// Routes
fastify.get('/', async (request, reply) => {
    reply.type('text/html').send(htmlTemplate);
});


fastify.post('/scrape', async (req, reply) => {
    //const { query, limit } = req.body;
    //const maxResults = parseInt(limit) || 10;
    const { query } = req.body;
    const maxResults = parseInt(20);

    // Add user data dir to avoid being bot
    const browser = await chromium.launch({
        headless: true, // Set to false if you want visual troubleshooting
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'en-US' // Force English for consistent selectors
    });

    const page = await context.newPage();

    try {
        console.log(`Memulai pencarian: ${query}`);

        // TRIK 1: Langsung ke URL pencarian agar tidak perlu ngetik di search box
        // Ini menghindari error "input#searchboxinput not found"
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;

        console.log("Navigasi langsung ke URL pencarian...");
        await page.goto(searchUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // TRIK 2: Tunggu sebentar untuk antisipasi redirect/cookie consent
        await page.waitForTimeout(3000);

        // Handle Cookie Consent jika muncul
        try {
            const consentSelectors = ['button[aria-label="Accept all"]', 'span:has-text("Accept all")', 'button:has-text("I agree")'];
            for (const sel of consentSelectors) {
                const btn = page.locator(sel).first();
                if (await btn.isVisible()) {
                    await btn.click();
                    console.log("Cookie consent diklik.");
                    await page.waitForTimeout(2000);
                    break;
                }
            }
        } catch (e) { }

        // TRIK 3: Cek apakah hasil sudah muncul
        console.log("Menunggu feed hasil muncul...");
        const feedSelector = 'div[role="feed"]';
        const singleResultSelector = 'div[role="main"]'; // Jika hanya 1 hasil ketemu

        try {
            await Promise.race([
                page.waitForSelector(feedSelector, { timeout: 20000 }),
                page.waitForSelector('a[href*="/maps/place/"]', { timeout: 20000 })
            ]);
        } catch (e) {
            console.log("Feed tidak langsung muncul, mencoba scroll untuk trigger...");
            await page.mouse.wheel(0, 500);
        }

        // --- PROSES SCROLLING ---
        let links = new Set();
        let scrollAttempts = 0;

        while (links.size < maxResults && scrollAttempts < 25) {
            const anchors = await page.locator('a[href*="/maps/place/"]').all();
            for (const a of anchors) {
                const href = await a.getAttribute('href');
                if (href) {
                    const cleanUrl = href.split('?')[0];
                    links.add(cleanUrl);
                }
                if (links.size >= maxResults) break;
            }

            if (links.size >= maxResults) break;

            // Scroll pada container feed
            const feedExists = await page.locator(feedSelector).count() > 0;
            if (feedExists) {
                await page.locator(feedSelector).evaluate(n => n.scrollBy(0, 1000));
            } else {
                await page.mouse.wheel(0, 1000);
            }

            await page.waitForTimeout(1500);
            scrollAttempts++;
            process.stdout.write(`Mencari link... (${links.size}/${maxResults})\r`);
        }

        const linksArray = Array.from(links).slice(0, maxResults);
        console.log(`\nMenemukan ${linksArray.length} tempat. Mengambil detail...`);

        // --- SCRAPING DETAIL ---
        const results = [];
        for (let i = 0; i < linksArray.length; i += 3) {
            const chunk = linksArray.slice(i, i + 3);
            const batch = await Promise.all(chunk.map(url => scrapeBusinessDetails(browser, url)));
            results.push(...batch.filter(r => r !== null));
        }

        // --- EXCEL GENERATION ---
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('G-Maps Results');
        sheet.columns = [
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Phone', key: 'phone', width: 20 },
            { header: 'Email', key: 'email', width: 25 },
            { header: 'Address', key: 'address', width: 40 },
            { header: 'Website', key: 'website', width: 35 },
            { header: 'Maps URL', key: 'url', width: 50 }
        ];
        sheet.addRows(results);

        const buffer = await workbook.xlsx.writeBuffer();

        console.log("Mengirim file ke browser...");
        reply
            .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            .header('Content-Disposition', `attachment; filename="data_${query.replace(/\s+/g, '_')}.xlsx"`)
            .send(buffer);

    } catch (err) {
        console.error("ERROR:", err.message);
        // Kirim error ke UI agar user tahu
        reply.status(500).send({ error: err.message });
    } finally {
        await browser.close();
        console.log("Selesai.");
    }
});

// Start Server
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`\nServer jalan di http://localhost:${PORT}`);
    console.log(`Buka browser Anda sekarang!`);
});