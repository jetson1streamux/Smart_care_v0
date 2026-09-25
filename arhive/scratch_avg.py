import sqlite3
import datetime
import sys

def main():
    conn = sqlite3.connect('rbatpm.db')
    conn.row_factory = sqlite3.Row
    alerts = [dict(row) for row in conn.execute('SELECT * FROM alerts')]
    verified = [a for a in alerts if a.get('reviewer_time') and a.get('timestamp')]
    
    if verified:
        total = 0
        for a in verified:
            try:
                start = datetime.datetime.fromisoformat(a['timestamp'])
                end = datetime.datetime.fromisoformat(a['reviewer_time'])
                total += (end - start).total_seconds()
            except ValueError:
                pass # skip invalid formats
        print(f'Avg Turnaround Time: {total / len(verified):.1f}s')
    else:
        print('No verified alerts')

if __name__ == '__main__':
    main()
