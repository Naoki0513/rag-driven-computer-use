# utils.py
import asyncio
from typing import List
from urllib.parse import urlparse
import logging
from .constants import logger

def is_internal_link(config, url: str) -> bool:
    base_domain = urlparse(config['target_url']).netloc
    target_domain = urlparse(url).netloc
    return base_domain == target_domain

async def gather_with_semaphore(config, tasks: List) -> List:
    results = []
    batch_size = config['parallel_tasks']
    for i in range(0, len(tasks), batch_size):
        batch = tasks[i:i + batch_size]
        batch_results = await asyncio.gather(*batch, return_exceptions=True)
        for result in batch_results:
            if isinstance(result, Exception):
                logger.info(f"Task error: {result}")
            else:
                results.append(result)
    return results 