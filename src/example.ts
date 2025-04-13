import { erc20Abi } from "viem";
import { Chaindexer } from "./Chaindexer";

let totalDetectedEvents = 0;
async function main() {
  const indexer = new Chaindexer({
    chainId: 1, // Ethereum Mainnet
    rpcUrl: "https://mainnet.infura.io/v3/0be86a45a4c3431398571a7c81165708", // Replace with your RPC URL
    wsRpcUrl: "wss://mainnet.infura.io/ws/v3/0be86a45a4c3431398571a7c81165708", // Replace with your WebSocket RPC URL
    contracts: [
      {
        name: "USDC",
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        abi: erc20Abi
        // initialBlock: 21085507 // Specify the starting block for this contract
      }
    ],
    // Control flags
    enabled: true,           // Master on/off switch for the entire indexer
    listenerEnabled: true,   // Enable real-time event listeners
    pollingEnabled: true,    // Enable historical polling
    pollIntervalMs: 1 * 60 * 1000,   // Poll every minute
    chunkSize: 50,           // Process 50 blocks at a time
    rpcDelayMs: 3000,
    logging: true
  });

  // Listen for logs
  indexer.on("log", (data) => {
    // Log data source and block tracking info
    console.log(`New event from ${data.contractName} (${data.source}):`, data);
    // Example of handling specific events using the enhanced data
    if (data.parsedEvent.name === "Transfer") {
      // Access parsed arguments from data.parsedEvent.args
      const args = data.parsedEvent.args;
      // For named properties (depends on the contract's ABI)
      // In ethers v5, args may have both numeric indices and named properties
      const from = args.from
      const to = args.to 
      const value = args.value

      console.log(`Transfer: ${from} -> ${to} amount: ${value}`);

      // Use the new blockDistance property to show how far back the event is
      if (data.source === 'polling') {
        // This event came from historical polling
        console.log(`Historical event from ${data.blockNumber}`);
      } else if (data.source === 'listener') {
        // This event came from real-time listener
        console.log(`Real-time event (just happened)`);
      }
    } else if (data.parsedEvent.name === "Approval") {
      const args = data.parsedEvent.args;
      const owner = args.owner
      const spender = args.spender
      const value = args.value

      console.log(`Approval: owner=${owner}, spender=${spender}, value=${value}`);
    }

    totalDetectedEvents+=1
    console.log('Total Detected Events', totalDetectedEvents)
  });

  // Listen for errors
  indexer.on("error", (error) => {
    console.error("Indexer Error:", error);
  });

  // Start indexing - now using await since start() is async
  await indexer.start();
  console.log("Chaindexer started. Press Ctrl+C to stop.");

  // Keep the process running
  process.on('SIGINT', () => {
    console.log('Stopping chaindexer...');
    indexer.stop();
    process.exit(0);
  });
}

main().catch((err) => console.error("Main error:", err)); 