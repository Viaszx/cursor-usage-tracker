# Cursor Usage Tracker

Automated Cursor AI usage monitoring with data collection and web dashboard.

## Features

- **Automated data collection** - extracts usage statistics from Cursor
- **Incremental synchronization** - loads only new events
- **Smart event updates** - detects and updates events with changed data
- **Real-time updates** - data updates automatically without page reload
- **Detailed analytics** - statistics by models, event types, tokens and costs
- **Web dashboard** - convenient interface for data viewing

## Statistics

- **General metrics**: events, tokens, cost, credits
- **Token breakdown**: Input, Output, Cache Read, Cache Write
- **User information**: email, plan, balance, status

## Technologies

- **Node.js** - server side
- **Playwright** - browser automation
- **Express** - web server
- **Server-Sent Events** - real-time updates
- **Vanilla JavaScript** - frontend

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Setup cookies**
   ```bash
   # Ensure the cookies.json file contains valid and up-to-date cookies for .cursor.com
   ```

3. **Run application**
   ```bash
   npm run start:cookies
   ```

4. **Open dashboard**
   ```
   http://localhost:3000
   ```

## Project Structure

```
src/
├── app.js              # Main application file
├── browser/            # Browser management
├── collectors/         # Data collection
├── config/            # Configuration
├── storage/           # Data storage
├── utils/             # Utilities
└── web/               # Web interface
    └── public/        # Static files
```

## Automation

- **Initial load**: full synchronization of all historical data
- **Subsequent**: incremental loading of new events
- **Event updates**: detects and updates events with changed data (credits, tokens, etc.)
- **Real-time**: automatic dashboard updates when new data appears
- **Fallback**: API error handling with adaptive page sizes

## Data Storage

Data is saved in `data/` folder:
- `usage_data.json` - all usage events
- `stats.json` - aggregated statistics  
- `user_info.json` - user information

## Configuration

Main settings in `src/config/constants.js`:
- `SERVER_PORT` - web server port (3000)
- `HEADLESS` - browser headless mode
- `ACTIVE_EVENTS_CHECK_HOURS` - check events for updates within N hours (24)
- `ACTIVE_EVENTS_MAX_COUNT` - maximum events to check for updates (100)
