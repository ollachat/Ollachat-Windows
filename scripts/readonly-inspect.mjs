import sqlite3 from 'sqlite3';
import path from 'path';

const dbPath = path.join(process.env.APPDATA, 'ollachat-windows', 'databases', 'users', 'a8f85b84-4bfa-4edc-aff9-fca087d7c047', 'ollachat.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Failed to open DB in readonly mode:', err.message);
    process.exit(1);
  }
});

db.serialize(() => {
  db.all("SELECT name FROM sqlite_master WHERE type='table';", (err, tables) => {
    if (err) return console.error('Error listing tables:', err);
    console.log('--- TABLES ---');
    console.log(tables.map(t => t.name));
  });

  db.all('SELECT id, client_message_id, sender_id, status, created_at FROM messages ORDER BY created_at DESC LIMIT 10;', (err, rows) => {
    if (err) return console.error('Error querying messages:', err);
    console.log('--- LATEST 10 MESSAGES ---');
    console.log(JSON.stringify(rows, null, 2));
  });

  db.get('SELECT count(*) as count FROM message_receipts;', (err, row) => {
    if (err) return console.error('Error message_receipts:', err);
    console.log('--- MESSAGE RECEIPTS COUNT ---', row);
  });

  db.get('SELECT count(*) as count FROM staged_receipts;', (err, row) => {
    if (err) return console.log('staged_receipts error:', err.message);
    console.log('--- STAGED RECEIPTS COUNT ---', row);
  });

  db.all('SELECT * FROM message_receipts LIMIT 10;', (err, rows) => {
    if (!err && rows && rows.length > 0) {
      console.log('--- MESSAGE RECEIPTS ROWS ---', rows);
    }
  });

  db.all('SELECT * FROM staged_receipts LIMIT 10;', (err, rows) => {
    if (!err && rows && rows.length > 0) {
      console.log('--- STAGED RECEIPTS ROWS ---', rows);
    }
  });
});

setTimeout(() => {
  db.close();
}, 2000);
