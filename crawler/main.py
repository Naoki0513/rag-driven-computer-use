# main.py
import asyncio
import argparse
import logging
from .constants import *
from .crawler import WebCrawler

async def main():
    parser = argparse.ArgumentParser(description='Web application state graph crawler')
    parser.add_argument('--url', default=TARGET_URL, help='Target URL to crawl')
    parser.add_argument('--user', default=LOGIN_USER, help='Login username')
    parser.add_argument('--password', default=LOGIN_PASS, help='Login password')
    parser.add_argument('--depth', type=int, default=MAX_DEPTH, help='Max exploration depth')
    parser.add_argument('--limit', type=int, default=MAX_STATES, help='Max states')
    parser.add_argument('--headful', action='store_true', help='Show browser')
    parser.add_argument('--parallel', type=int, default=PARALLEL_TASKS, help='Parallel tasks')
    parser.add_argument('--no-clear', action='store_true', help='Do not clear database')
    parser.add_argument('--exhaustive', action='store_true', help='Exhaustive crawl ignoring limits')
    
    args = parser.parse_args()
    
    logging.basicConfig(level=logging.DEBUG if args.headful else logging.INFO, format='%(asctime)s %(levelname)-5s %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
    
    config = {
        'neo4j_uri': NEO4J_URI,
        'neo4j_user': NEO4J_USER,
        'neo4j_password': NEO4J_PASSWORD,
        'target_url': args.url,
        'login_user': args.user,
        'login_pass': args.password,
        'max_depth': args.depth,
        'max_states': args.limit,
        'headful': args.headful,
        'parallel_tasks': args.parallel,
        'clear_db': not args.no_clear,
        'exhaustive': args.exhaustive
    }
    
    async with WebCrawler(config) as crawler:
        await crawler.run()

if __name__ == '__main__':
    asyncio.run(main()) 