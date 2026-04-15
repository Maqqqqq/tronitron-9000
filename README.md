# Tronitron 9000

A Tron-like survival game. Up to four players join from their browsers, steer with the keyboard, and outlast their rivals.

## Getting Started

```bash
npm install
npm start
```

Open http://localhost:3000 in up to four browser tabs/windows (or share the host/port with friends).

## Controls
- Move: Arrow Keys or WASD
- Open/close menu: Esc or the Menu button
- Pause/Resume/Quit: use the buttons inside the menu (any player)
- Restart match / Return to lobby: menu options available to the host only

## Quick ngrok

1. Install ngrok and add your auth token (see https://ngrok.com/):
   ```bash
   ngrok config add-authtoken YOUR_TOKEN
   ```
2. Start the server locally:
   ```bash
   npm start
   ```
3. In another terminal, expose port 3000:
   ```bash
   ngrok http 3000
   ```
Share the HTTPS forwarding URL that ngrok prints so friends can join your lobby.
