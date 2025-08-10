import { loadConfig } from './config.js';
import { WebCrawler } from './crawler.js';

async function main() {
  const config = loadConfig();
  const crawler = new WebCrawler(config);
  await crawler.initialize();
  try {
    await crawler.run();
  } finally {
    await crawler.cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

