#!/usr/bin/env python3
"""
Pull 5-minute SPX bars from IBKR TWS/Gateway.
Saves to spx_5min.csv with columns: date,open,high,low,close,volume

Requirements:
  pip install ib_insync
  TWS or IB Gateway running with API enabled on port 7497 (TWS paper) or 7496 (TWS live)

Usage:
  python3 pull_ibkr_5min.py          # pulls from 2024-03-22 to today
  python3 pull_ibkr_5min.py --port 7496  # use live TWS port
"""

import argparse
import asyncio
import time
import os
from datetime import datetime, timedelta

# Fix for Python 3.10+ where get_event_loop() raises if no loop exists
try:
    asyncio.get_event_loop()
except RuntimeError:
    asyncio.set_event_loop(asyncio.new_event_loop())

from ib_insync import IB, Index, util
import pandas as pd

def pull_5min_data(port=7497, start_date='2024-03-22', output='spx_5min.csv'):
    ib = IB()
    print(f'Connecting to IBKR on port {port}...')
    try:
        ib.connect('127.0.0.1', port, clientId=99, timeout=15)
    except Exception as e:
        print(f'ERROR: Could not connect to IBKR on port {port}.')
        print(f'Make sure TWS or IB Gateway is running with API enabled.')
        print(f'  TWS: File > Global Configuration > API > Settings > Enable ActiveX and Socket Clients')
        print(f'  TWS Paper: port 7497 | TWS Live: port 7496')
        print(f'  Gateway Paper: port 4002 | Gateway Live: port 4001')
        print(f'Detail: {e}')
        return

    print('Connected. Qualifying SPX contract...')
    contract = Index('SPX', 'CBOE', 'USD')
    ib.qualifyContracts(contract)
    print(f'Contract: {contract}')

    start = datetime.strptime(start_date, '%Y-%m-%d')
    end = datetime.now()

    # Check if we have an existing file to resume from
    existing_df = None
    if os.path.exists(output):
        existing_df = pd.read_csv(output, parse_dates=['date'])
        last_date = existing_df['date'].max()
        if pd.notna(last_date):
            # Resume from the last date we have
            resume_from = last_date.to_pydatetime() + timedelta(days=1)
            if resume_from > start:
                print(f'Found existing data up to {last_date.strftime("%Y-%m-%d")}. Resuming from {resume_from.strftime("%Y-%m-%d")}...')
                start = resume_from

    total_days = (end - start).days
    if total_days <= 0:
        print('Data is already up to date!')
        if existing_df is not None:
            print(f'File: {output} ({len(existing_df)} bars)')
        ib.disconnect()
        return

    num_chunks = (total_days // 20) + 1
    print(f'Pulling {total_days} days of 5-min data in ~{num_chunks} chunks (20 days each)...')
    print(f'Range: {start.strftime("%Y-%m-%d")} to {end.strftime("%Y-%m-%d")}')
    print(f'Estimated time: ~{num_chunks * 11} seconds ({num_chunks} requests × 11s pacing)\n')

    all_bars = []
    chunk_end = end
    request_num = 0

    while chunk_end > start:
        request_num += 1
        end_str = chunk_end.strftime('%Y%m%d-%H:%M:%S')
        print(f'  [{request_num}/{num_chunks}] Requesting up to {chunk_end.strftime("%Y-%m-%d %H:%M")}...', end=' ', flush=True)

        try:
            bars = ib.reqHistoricalData(
                contract,
                endDateTime=end_str,
                durationStr='20 D',
                barSizeSetting='5 mins',
                whatToShow='TRADES',
                useRTH=True,
                formatDate=1,
                timeout=30
            )
        except Exception as e:
            print(f'ERROR: {e}')
            if 'pacing' in str(e).lower():
                print('  Pacing violation — waiting 60s...')
                time.sleep(60)
                continue
            else:
                print('  Skipping chunk, waiting 15s...')
                chunk_end -= timedelta(days=20)
                time.sleep(15)
                continue

        if not bars:
            print('no data returned (may have reached data limit)')
            chunk_end -= timedelta(days=20)
            time.sleep(5)
            continue

        print(f'{len(bars)} bars ({bars[0].date.strftime("%Y-%m-%d")} to {bars[-1].date.strftime("%Y-%m-%d")})')
        all_bars.extend(bars)

        # Move end to just before the earliest bar we got
        earliest = bars[0].date
        if isinstance(earliest, datetime):
            # Strip timezone info to keep everything naive
            if earliest.tzinfo is not None:
                earliest = earliest.replace(tzinfo=None)
            chunk_end = earliest - timedelta(minutes=1)
        else:
            chunk_end = datetime.combine(earliest, datetime.min.time()) - timedelta(minutes=1)

        # Pacing: 10s between requests to stay under 60 req / 10 min limit
        time.sleep(11)

    ib.disconnect()

    if not all_bars:
        print('\nNo new data retrieved.')
        return

    # Convert to DataFrame
    df = util.df(all_bars)
    df = df[['date', 'open', 'high', 'low', 'close', 'volume']].copy()
    df = df.drop_duplicates(subset='date').sort_values('date').reset_index(drop=True)

    # Merge with existing data if resuming
    if existing_df is not None:
        df = pd.concat([existing_df, df], ignore_index=True)
        df = df.drop_duplicates(subset='date').sort_values('date').reset_index(drop=True)

    # Save
    df.to_csv(output, index=False)

    # Summary
    trading_days = df['date'].dt.date.nunique()
    bars_per_day = len(df) / trading_days if trading_days > 0 else 0
    print(f'\nDone! Saved {len(df)} bars across {trading_days} trading days ({bars_per_day:.0f} bars/day)')
    print(f'Date range: {df["date"].min()} to {df["date"].max()}')
    print(f'File: {output} ({os.path.getsize(output) / 1024:.0f} KB)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Pull 5-min SPX bars from IBKR')
    parser.add_argument('--port', type=int, default=7497, help='TWS/Gateway port (default: 7497)')
    parser.add_argument('--start', type=str, default='2024-03-22', help='Start date YYYY-MM-DD')
    parser.add_argument('--output', type=str, default='spx_5min.csv', help='Output CSV file')
    args = parser.parse_args()
    pull_5min_data(port=args.port, start_date=args.start, output=args.output)
