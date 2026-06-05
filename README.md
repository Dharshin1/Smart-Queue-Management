# Smart Token & Queue Management System v2
Government Hospital OPD — Offline-First Backend

## What's New in v2
- ✅ Works WITHOUT Arduino/hardware (Software-Only Mode)
- ✅ Priority Queue (Emergency > Senior Citizen > Normal)
- ✅ Waiting Time Prediction (AI-based, learns from history)
- ✅ Mark as Served button (records service time for predictions)

## How to Run
1. npm install
2. node server.js
3. Open http://localhost:3000

No hardware needed. No MySQL needed. Just Node.js.

## Optional Setup
- Copy .env.example to .env and fill in MySQL details for cloud sync
- If you have Arduino, set ARDUINO_PORT in .env
