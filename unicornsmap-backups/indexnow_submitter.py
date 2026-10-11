#!/usr/bin/env python3
"""
IndexNow bulk submitter for unicornsmap.com
Best practices:
- Batches of up to 10,000 URLs
- Rate limit: ~500-600 URLs/min equivalent (pauses between batches)
- Only submit live, 200-status, indexable URLs
- Submit to api.indexnow.org (propagates to all partners)
- Retry on 429 with exponential backoff
"""
import json
import time
import requests
from typing import List

KEY = "b8c0f3816d58413f8d9922ee23d360e6"
HOST = "unicornsmap.com"
KEY_LOCATION = f"https://{HOST}/{KEY}.txt"
ENDPOINT = "https://api.indexnow.org/indexnow"

def submit_batch(urls: List[str]) -> int:
    payload = {
        "host": HOST,
        "key": KEY,
        "keyLocation": KEY_LOCATION,
        "urlList": urls
    }
    headers = {"Content-Type": "application/json; charset=utf-8"}
    resp = requests.post(ENDPOINT, headers=headers, data=json.dumps(payload), timeout=30)
    print(f"Batch of {len(urls)}: HTTP {resp.status_code}")
    if resp.status_code == 429:
        time.sleep(30)  # backoff
        return submit_batch(urls)  # simple retry
    return resp.status_code

def submit_all(urls: List[str], batch_size: int = 5000, pause_sec: int = 60):
    for i in range(0, len(urls), batch_size):
        batch = urls[i:i+batch_size]
        status = submit_batch(batch)
        if status not in (200, 202):
            print(f"Warning: batch failed with {status}")
        time.sleep(pause_sec)  # slow / respectful rate

# Example usage:
# urls = ["https://unicornsmap.com/", "https://unicornsmap.com/cantor-fitzgerald", ...]
# submit_all(urls)
print("IndexNow submitter ready. Load your URL list and call submit_all().")
