import { ethers } from "ethers";
import { EventEmitter } from "events";

export interface ContractConfig {
  name: string;
  address: string;
  abi: any;
  /**
   * If you want to start from a certain block. 
   * For example, the block where this contract was deployed.
   * If not provided, defaults to (current block - 10000)
   */
  initialBlock?: number;
}

export interface ChaindexerOptions {
  chainId: number;
  rpcUrl: string;
  wsRpcUrl: string;  // WebSocket URL for real-time events
  contracts: ContractConfig[];
  pollIntervalMs?: number;    // how often we do a fallback poll, default 5 minutes
  chunkSize?: number;         // how many blocks to fetch in one chunk, default 200
  enabled?: boolean;          // master flag to enable/disable both polling and listeners, default true
  listenerEnabled?: boolean;  // enable/disable real-time WebSocket listeners, default true
  pollingEnabled?: boolean;   // enable/disable historical polling, default true
  rpcDelayMs?: number;        // delay between RPC calls in milliseconds, default 5000
  logging?: boolean;          // controls whether to log to console, default true
}

/**
 * Event data structure emitted on each processed log
 */
export interface LogEventData {
  // Core event data
  contractName: string;
  address: string;
  blockNumber: number;
  transactionHash: string;
  source: 'listener' | 'polling'; // Indicates where this event came from
  lastProcessedBlock: number;     // The last processed block for this contract when this event was processed
  
  // Parsed event data (with formatted values)
  parsedEvent: ethers.utils.LogDescription;
  
  // Raw event data (for advanced use cases)
  rawEvent: ethers.Event                  // The complete raw event object
}

// Define the events interface for TypeScript autocomplete
export interface ChaindexerEvents {
  log: (data: LogEventData) => void;
  error: (error: Error) => void;
}

export declare interface Chaindexer {
  on<E extends keyof ChaindexerEvents>(event: E, listener: ChaindexerEvents[E]): this;
  once<E extends keyof ChaindexerEvents>(event: E, listener: ChaindexerEvents[E]): this;
  emit<E extends keyof ChaindexerEvents>(event: E, ...args: Parameters<ChaindexerEvents[E]>): boolean;
}

export class Chaindexer extends EventEmitter {
  private provider: ethers.providers.JsonRpcProvider;
  private wsProvider: ethers.providers.WebSocketProvider;
  private contracts: Array<{
    name: string;
    address: string;
    abi: any;
    initialBlock: number;
    interface: ethers.utils.Interface;
    lastProcessedBlock: number;  // internal state
    contractInstance: ethers.Contract;
    wsContractInstance: ethers.Contract;
  }>;

  private pollInterval: number;
  private chunkSize: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private enabled: boolean;
  private listenerEnabled: boolean;
  private pollingEnabled: boolean;
  private rpcDelayMs: number;
  private logging: boolean;

  /**
   * @param options - configuration for the indexer
   */
  constructor(private options: ChaindexerOptions) {
    super();
    this.provider = new ethers.providers.JsonRpcProvider(options.rpcUrl);
    this.wsProvider = new ethers.providers.WebSocketProvider(options.wsRpcUrl);

    // First, get the current block to use as reference for initialBlock defaults
    this.contracts = [];
    
    // Set flags with defaults first
    this.pollInterval = options.pollIntervalMs ?? 5 * 60 * 1000; // default 5min
    this.chunkSize = options.chunkSize ?? 100; // default 100 blocks - reduced from 1000 to stay under limits
    this.enabled = options.enabled ?? true;
    this.listenerEnabled = options.listenerEnabled ?? true;
    this.pollingEnabled = options.pollingEnabled ?? true;
    this.rpcDelayMs = options.rpcDelayMs ?? 5000; // default 5 seconds
    this.logging = options.logging ?? true;
  }

  /**
   * Initialize contracts after provider connection is established
   */
  private async initializeContracts() {
    // Get current block to use as reference for initialBlock defaults
    const currentBlock = await this.provider.getBlockNumber();
    const defaultInitialBlock = Math.max(1, currentBlock - 100); // Go back 10000 blocks, but never below 1
    
    this.contracts = this.options.contracts.map(cfg => {
      return {
        ...cfg,
        interface: new ethers.utils.Interface(cfg.abi),
        // Use initialBlock if provided, otherwise use (currentBlock - 10000)
        lastProcessedBlock: cfg.initialBlock ?? defaultInitialBlock,
        initialBlock: cfg.initialBlock ?? defaultInitialBlock,
        contractInstance: new ethers.Contract(cfg.address, cfg.abi, this.provider),
        wsContractInstance: new ethers.Contract(cfg.address, cfg.abi, this.wsProvider)
      };
    });
    
    // Log initial block information for each contract
    this.log(`Current block height: ${currentBlock}`);
    this.contracts.forEach(contract => {
      this.log(`Contract ${contract.name} starting at block ${contract.initialBlock} (${currentBlock - contract.initialBlock} blocks behind head)`);
    });
  }

  /**
   * Start the indexer:
   * - Initialize contracts with proper block references
   * - Listen to real-time events
   * - Start polling routine
   */
  public async start() {
    if (!this.enabled) {
      this.warn("Chaindexer is disabled. Not starting listeners or polling.");
      return;
    }
    
    // Initialize contracts first
    await this.initializeContracts();
    
    // Log initialization with configuration details
    this.log(
      `Initialized Chaindexer on chain ${this.options.chainId} with ${this.contracts.length} contracts:
      - Contracts: ${this.contracts.map(c => `${c.name}@${c.address}`).join(', ')}
      - Polling interval: ${this.pollInterval}ms
      - Chunk size: ${this.chunkSize} blocks
      - Real-time listeners: ${this.listenerEnabled ? 'enabled' : 'disabled'}
      - Historical polling: ${this.pollingEnabled ? 'enabled' : 'disabled'}
      - RPC delay: ${this.rpcDelayMs}ms`
    );
    
    if (this.listenerEnabled) {
      this.setupRealtimeListeners();
    } else {
      this.log("Real-time listeners are disabled");
    }
    
    if (this.pollingEnabled) {
      this.schedulePolling();
    } else {
      this.log("Historical polling is disabled");
    }
  }

  /**
   * Stop the indexer:
   * - Remove real-time event listeners
   * - Clear polling interval
   */
  public stop() {
    // Remove all listeners from each contract
    for (const c of this.contracts) {
      c.contractInstance.removeAllListeners();
      c.wsContractInstance.removeAllListeners();
    }
    // Clear the poll timer
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Close WS connection
    this.wsProvider.removeAllListeners();
  }

  /**
   * Set up real-time listeners for each contract
   */
  private setupRealtimeListeners() {
    for (const c of this.contracts) {
      // Get event fragments from the interface
      const eventFragments = Object.values(c.interface.fragments)
        .filter(fragment => fragment.type === 'event')
        .map(fragment => fragment as ethers.utils.EventFragment);
      
      if (eventFragments.length > 0) {
        const eventNames = eventFragments.map(f => f.name);
        this.log(`Setting up listeners for ${c.name} (${c.address}) events: ${eventNames.join(', ')}`);
        
        // Set up listeners for each named event
        for (const fragment of eventFragments) {
          const eventName = fragment.name;
          c.wsContractInstance.on(eventName, (...args: any[]) => {
            try {
              // In ethers v5, the event args are followed by the event object
              const event = args[args.length - 1];
              
              const blockNumber = event.blockNumber;
              if (!blockNumber) {
                this.warn(`Event missing blockNumber for ${eventName}`);
                return;
              }
              
              // Don't skip events from the same block we processed, only older blocks
              // This prevents missing events in real-time that happen in the same block
              if (blockNumber < c.lastProcessedBlock) {
                return;
              }
              
              // Process and format arguments to match the polling format
              // Create an object with both numeric indices and named properties
              const formattedArgs: any = {};
              const eventInputs = fragment.inputs || [];
              const eventArgs = args.slice(0, -1);
              
              // Add positional (numeric) arguments
              for (let i = 0; i < eventArgs.length; i++) {
                formattedArgs[i] = this.formatValue(eventArgs[i]);
              }
              
              // Add named arguments
              for (let i = 0; i < Math.min(eventInputs.length, eventArgs.length); i++) {
                const input = eventInputs[i];
                if (input.name) {
                  formattedArgs[input.name] = this.formatValue(eventArgs[i]);
                }
              }
              
              // Create a log description-like object for compatibility
              const eventData: LogEventData = {
                // Core event data
                contractName: c.name,
                address: event.address,
                blockNumber: event.blockNumber,
                transactionHash: event.transactionHash || '',
                source: 'listener',
                lastProcessedBlock: c.lastProcessedBlock,
                
                // Parsed event data
                parsedEvent: {
                  name: eventName,
                  signature: fragment.format(),
                  topic: ethers.utils.id(fragment.format()),
                  args: formattedArgs,
                  eventFragment: fragment
                } as unknown as ethers.utils.LogDescription,
                
                // Raw event data
                rawEvent: event
              };
              
              // Only log detection after verifying everything is valid
              this.log(`Detected ${eventName} event from address: ${event.address} [via listener]`);
              
              // Emit the log event for user's listeners
              this.emit("log", eventData);
              
              // Update in-memory lastProcessedBlock ONLY after successfully emitting
              // and only if this event's block is higher than what we've processed before
              if (blockNumber > c.lastProcessedBlock) {
                c.lastProcessedBlock = blockNumber;
              }
              
              // For Transfer events, log the raw transfer details
              if (eventName === 'Transfer') {
                const [from, to, value] = args.slice(0, -1);
                // This log is just for debugging - we can remove it if it's too verbose
                // console.log(`Raw Transfer event: ${from} -> ${to}, ${value.toString()} (from contract: ${event.address})`);
              }
            } catch (err) {
              this.error(`Error handling ${eventName} event:`, err);
            }
          });
        }
      } else {
        this.warn(`No events found in ABI for contract ${c.name}`);
      }
    }
  }

  /**
   * Sets an interval to run the catch-up routine
   */
  private schedulePolling() {
    this.pollTimer = setInterval(() => {
      if (this.pollingEnabled && this.enabled) {
        this.catchUpRoutine().catch(err => {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        });
      }
    }, this.pollInterval);
    
    // Run the catch-up routine immediately once to get historical events
    if (this.pollingEnabled && this.enabled) {
      this.catchUpRoutine().catch(err => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
    }
  }

  /**
   * Catch-up routine:
   * - For each contract, fetch logs from [lastProcessedBlock+1..currentBlock]
   * - Process them in chunked ranges to avoid huge calls
   * - Update lastProcessedBlock
   */
  private async catchUpRoutine() {
    const currentBlock = await this.provider.getBlockNumber();
    this.log(`Current blockchain height: ${currentBlock}`);

    // Process each contract one by one
    for (const c of this.contracts) {
      let fromBlock = c.lastProcessedBlock + 1;
      if (fromBlock > currentBlock) {
        this.log(`Contract ${c.name} is already up to date at block ${c.lastProcessedBlock}`);
        continue;
      }

      this.log(`Processing events for ${c.name} from block ${fromBlock} to ${currentBlock} (${currentBlock - fromBlock + 1} blocks)`);
      let dynamicChunkSize = this.chunkSize;

      // Process blocks in chronological order (from oldest to newest)
      while (fromBlock <= currentBlock) {
        const toBlock = Math.min(fromBlock + dynamicChunkSize - 1, currentBlock);

        try {
          this.log(`Fetching logs for ${c.name} (${c.address}) from ${fromBlock} to ${toBlock} (${toBlock - fromBlock + 1} blocks, chunk size: ${dynamicChunkSize})`);
          
          // Record the previous lastProcessedBlock to detect if it changed
          const prevLastProcessedBlock = c.lastProcessedBlock;
          
          // Use the method to query events - events within this range will be sorted by block number
          const startTime = Date.now();
          await this.queryContractEvents(c, fromBlock, toBlock);
          const elapsed = Date.now() - startTime;
          
          // Log block progression details
          this.log(`Processed logs for blocks ${fromBlock}-${toBlock} in ${elapsed}ms`);
          this.log(`Block progress: before=${prevLastProcessedBlock}, after=${c.lastProcessedBlock}, expected=${toBlock}`);

          // Always advance to the next chunk based on the requested block range
          // rather than based on the last event processed. This ensures proper
          // sequential processing of all blocks, even if some blocks contain no events.
          fromBlock = toBlock + 1;
          this.log(`Moving to next chunk: fromBlock=${fromBlock}`);
          
          // Add delay between RPC calls
          if (fromBlock <= currentBlock) {
            this.log(`Waiting ${this.rpcDelayMs}ms before next RPC call...`);
            await new Promise(resolve => setTimeout(resolve, this.rpcDelayMs));
          }
        } catch (err: any) {
          if (err?.error?.code === -32005 || (typeof err?.message === 'string' && err.message.includes('query returned more than'))) {
            // Too many results - reduce chunk size and retry
            dynamicChunkSize = Math.max(5, Math.floor(dynamicChunkSize / 2));
            this.log(`Too many results, reducing chunk size to ${dynamicChunkSize} and retrying same range`);
            continue;
          }
          
          this.error(`Error processing logs for ${c.name} from ${fromBlock} to ${toBlock}:`, err);
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
          break;
        }
      }
      
      this.log(`Finished processing all events for ${c.name}, lastProcessedBlock=${c.lastProcessedBlock}`);
    }
  }

  /**
   * Query events from a contract using the contract instance's queryFilter method
   * This makes parsing automatic since it uses the contract's ABI
   */
  private async queryContractEvents(
    contract: {
      name: string;
      address: string;
      lastProcessedBlock: number;
      contractInstance: ethers.Contract;
      interface: ethers.utils.Interface;
    },
    fromBlock: number,
    toBlock: number
  ) {
    try {
      // Query all events from the contract using ethers v5 syntax
      const events = await contract.contractInstance.queryFilter('*', fromBlock, toBlock);
      
      this.log(`Found ${events.length} events for ${contract.name} (${contract.address}) from ${fromBlock} to ${toBlock}`);
      
      // Debug block ranges
      if (events.length > 0) {
        const firstEvent = events[0];
        const lastEvent = events[events.length - 1];
        this.log(`Events span from block ${firstEvent.blockNumber} to ${lastEvent.blockNumber}`);
        this.log(`Contract's lastProcessedBlock: ${contract.lastProcessedBlock}`);
      }
      
      // Sort events by block number and log index to ensure chronological order (oldest first)
      const sortedEvents = events.sort((a, b) => {
        // First sort by block number
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        
        // If same block, sort by transaction index
        if (a.transactionIndex !== b.transactionIndex) {
          return a.transactionIndex - b.transactionIndex;
        }
        
        // If same transaction, sort by log index
        return a.logIndex - b.logIndex;
      });
      
      // Track the highest block number we've seen in this batch
      let highestBlockProcessed = contract.lastProcessedBlock;
      let eventsEmitted = 0;
      let eventsSkipped = 0;
      let eventsByBlock: Record<number, number> = {};
      
      // Process each event
      for (const event of sortedEvents) {
        // Count events by block
        eventsByBlock[event.blockNumber] = (eventsByBlock[event.blockNumber] || 0) + 1;
        
        // Only process events that fall within our explicitly requested block range.
        // Since we're querying specific blocks, we only filter out events below our
        // minimum block threshold to ensure complete event processing within the range.
        if (event.blockNumber < fromBlock) {
          eventsSkipped++;
          continue;
        }
        
        try {
          // In ethers v5, we can access event name and args directly from the event
          if (!event.event || !event.args) {
            eventsSkipped++;
            continue;
          }
          
          // We've already checked event.args is not null above
          const args = event.args;
          
          // Format all values to strings if they're BigNumber
          const formattedArgs: any = {};
          Object.keys(args).forEach(key => {
            formattedArgs[key] = this.formatValue(args[key]);
          });
          
          const eventData: LogEventData = {
            // Core event data
            contractName: contract.name,
            address: event.address,
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash || '',
            source: 'polling',
            lastProcessedBlock: contract.lastProcessedBlock,
            
            // Parsed event data
            parsedEvent: {
              name: event.event,
              signature: event.eventSignature || '',
              topic: event.topics[0],
              args: formattedArgs,
              eventFragment: contract.interface.getEvent(event.event)
            } as unknown as ethers.utils.LogDescription,
            
            // Raw event data
            rawEvent: event
          };
          
          // Emit the log event
          this.emit("log", eventData);
          eventsEmitted++;
          
          // Update our tracking of the highest block processed
          if (event.blockNumber > highestBlockProcessed) {
            highestBlockProcessed = event.blockNumber;
          }
        } catch (err) {
          this.error(`Error processing event: ${err}`);
          eventsSkipped++;
          continue;
        }
      }
      
      // Log detailed event processing stats
      this.log(`Processing summary: ${eventsEmitted} events emitted, ${eventsSkipped} events skipped`);
      if (Object.keys(eventsByBlock).length > 0) {
        this.log('Events per block:', eventsByBlock);
      }
      
      // Only update the contract's lastProcessedBlock at the end of processing the chunk
      // This ensures we process all events in a block before moving on
      if (highestBlockProcessed > contract.lastProcessedBlock) {
        this.log(`Updating lastProcessedBlock from ${contract.lastProcessedBlock} to ${highestBlockProcessed} (emitted ${eventsEmitted} events)`);
        contract.lastProcessedBlock = highestBlockProcessed;
      } else {
        this.log(`No new blocks processed. Still at block ${contract.lastProcessedBlock} (emitted ${eventsEmitted} events)`);
      }
      
    } catch (err) {
      this.error(`Error querying events: ${err}`);
      throw err;
    }
  }

  // Add helper method to format values
  private formatValue(value: any): any {
    // Handle BigNumber conversion to string
    if (value && typeof value === 'object' && value._isBigNumber) {
      return value.toString();
    }
    
    // Handle arrays - check each element
    if (Array.isArray(value)) {
      return value.map(item => this.formatValue(item));
    }
    
    // Return other values as is
    return value;
  }

  // Private logging methods with prefix
  private log(message: string, ...args: any[]): void {
    if (this.logging) {
      console.log(`[CHAINDEXER]: ${message}`, ...args);
    }
  }

  private warn(message: string, ...args: any[]): void {
    if (this.logging) {
      console.warn(`[CHAINDEXER]: ${message}`, ...args);
    }
  }

  private error(message: string, ...args: any[]): void {
    if (this.logging) {
      console.error(`[CHAINDEXER]: ${message}`, ...args);
    }
  }
}