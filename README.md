# Chaindexer

A minimal and reliable library for tracking blockchain events in your Node.js backend application.

## Installation

```bash
npm install chaindexer
```

That's it! Now you can import and use Chaindexer in your project.

## What is Chaindexer?

Chaindexer is a simple tool that helps your backend listen to events happening on the blockchain (like token transfers, trades, etc.). It does two things really well:

1. **Real-time listening**: It catches events as they happen
2. **Catch-up polling**: It fills in any events you missed when your server was down

This makes it perfect for building reliable applications that need to track on-chain activity without missing anything.

## Quick Start

```javascript
import { Chaindexer } from "chaindexer";

// Create an indexer for a token contract
const indexer = new Chaindexer({
  chainId: 1, // Ethereum Mainnet
  rpcUrl: "https://mainnet.infura.io/v3/YOUR_API_KEY", 
  wsRpcUrl: "wss://mainnet.infura.io/ws/v3/YOUR_API_KEY",
  contracts: [
    {
      name: "USDC",
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      abi: erc20Abi // Your contract ABI
    }
  ]
});

// This is where you handle all events
indexer.on("log", (data) => {
  console.log(`Event: ${data.parsedEvent.name} from ${data.contractName}`);
  
  // You can easily tell if this event is from real-time or catch-up mode
  if (data.source === 'listener') {
    console.log("Real-time event just happened!");
  } else {
    console.log("Historical event from catch-up mode");
  }
  
  // Handle specific events
  if (data.parsedEvent.name === "Transfer") {
    const { from, to, value } = data.parsedEvent.args;
    console.log(`Transfer: ${from} → ${to}, Amount: ${value}`);
    
    // Do something with this event in your backend
    // e.g., updateDatabase(from, to, value);
  }
});

// Start the indexer
await indexer.start();
```

## How It Works

### The Problem: Missing Events

Imagine your backend tracks token transfers. What happens if:
- Your server goes down for an hour
- You deploy a new version of your app
- Your WebSocket connection drops temporarily

You'd miss events! This is where Chaindexer helps.

### The Solution: Two-track System

Chaindexer combines two approaches:

1. **WebSocket Listeners** - Get events in real-time as they happen
2. **Historical Polling** - Periodically check for missed events

This creates a reliable system that never misses an event, even if your backend was offline.

### Real-world Example

Let's say you're building a trading dashboard that needs to track token transfers:

```javascript
const indexer = new Chaindexer({
  chainId: 1,
  rpcUrl: "https://mainnet.infura.io/v3/YOUR_API_KEY",
  wsRpcUrl: "wss://mainnet.infura.io/ws/v3/YOUR_API_KEY",
  contracts: [{
    name: "USDC",
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    abi: erc20Abi
  }],
  // Check for missed events every 5 minutes
  pollIntervalMs: 5 * 60 * 1000
});

// Your database update function
async function updateDatabase(event) {
  // Skip if we've already processed this transaction
  const exists = await db.transactionExists(event.transactionHash);
  if (exists) return;
  
  // Store the event in your database
  if (event.parsedEvent.name === "Transfer") {
    await db.storeTransfer({
      from: event.parsedEvent.args.from,
      to: event.parsedEvent.args.to,
      amount: event.parsedEvent.args.value,
      block: event.blockNumber,
      tx: event.transactionHash
    });
  }
}

// Process all events - both real-time and historical
indexer.on("log", async (event) => {
  await updateDatabase(event);
  
  // Log where the event came from
  if (event.source === 'polling') {
    console.log(`Caught up with historical event from block ${event.blockNumber}`);
  } else {
    console.log(`Real-time event from block ${event.blockNumber}`);
  }
});

// Start indexing
await indexer.start();
```

### Handling Downtime

If your server is down for an hour and many transactions happen:

1. When your server restarts, Chaindexer notices its last processed block
2. The polling system automatically fetches all missed blocks and events
3. You process these events normally through the same `indexer.on("log")` handler
4. Your system catches up to real-time

All of this happens automatically without you having to write complex recovery code!

## Configuration Options

```javascript
const indexer = new Chaindexer({
  chainId: 1,
  rpcUrl: "...",
  wsRpcUrl: "...",
  contracts: [...],
  
  // Optional settings with defaults
  pollIntervalMs: 5 * 60 * 1000,  // How often to check for missed events (5 min)
  chunkSize: 100,                 // Process 100 blocks at a time
  enabled: true,                  // Master on/off switch
  listenerEnabled: true,          // Enable real-time listeners
  pollingEnabled: true,           // Enable catch-up polling
  rpcDelayMs: 5000,               // Delay between RPC calls (5 sec)
  logging: true                   // Enable logs
});
```

## Why Use Chaindexer?

- **Simple**: Just provide your contract, get events - that's it
- **Reliable**: Never miss an event, even during downtime
- **Lightweight**: Minimal dependencies, focused functionality
- **Typed**: Full TypeScript support with autocomplete
- **Flexible**: Works with any EVM-compatible blockchain

Perfect for building backends that need reliable blockchain event tracking without complex infrastructure. 