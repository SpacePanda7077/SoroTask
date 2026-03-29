# Keeper Plugin System Architecture (Resolvers)

## Overview

The SoroTask Keeper currently determines task readiness based on time intervals and on-chain state (e.g., executing a task when `last_run + interval` has elapsed). To support more complex, dynamic, and off-chain conditional logic, this document proposes a **Plugin Architecture for Custom Resolvers**.

A **Resolver** is a modular component that can:
1. Perform off-chain checks (e.g., API calls, price feeds, subgraph queries) to determine if a task is "ready".
2. Dynamically construct execution payloads or arguments required by the task on-chain.

This architecture enables Keepers to flexibly support diverse, advanced task automations without requiring forks or modifications to the core Keeper codebase.

---

## 1. Interface Definition

To ensure uniformity and ease of use, all custom resolvers must conform to a standardized interface. Since the SoroTask Keeper is built on Node.js, plugins will be structured as Javascript classes that implement the `ResolverPlugin` interface.

```javascript
/**
 * Interface that all SoroTask Keeper Resolver Plugins must implement.
 */
class BaseResolverPlugin {
  /**
   * Initializes the plugin with any necessary configuration.
   * This is called once during Keeper startup.
   * 
   * @param {Object} config - The plugin-specific configuration.
   * @param {Object} context - Global keeper context (logger, RPC provider, etc).
   */
  async init(config, context) {
    // Implement setup logic here (e.g., DB connections, websocket subscriptions)
  }

  /**
   * Evaluates if a specific task is ready for execution, and optionally 
   * provides execution payload/arguments.
   *
   * @param {string} taskId - The ID of the task being evaluated.
   * @param {Object} taskConfig - The current configuration of the task from the contract.
   * @returns {Promise<ResolverResult>}
   */
  async resolve(taskId, taskConfig) {
    throw new Error('resolve() must be implemented by the plugin');
  }

  /**
   * Cleans up resources upon Keeper shutdown.
   */
  async destroy() {
    // Implement teardown logic here
  }
}

/**
 * Expected return structure from resolve()
 * 
 * @typedef {Object} ResolverResult
 * @property {boolean} isReady - True if the task should be executed.
 * @property {Array<any>} [args] - Optional list of arguments to pass into the transaction.
 * @property {string} [reason] - Optional reason for skipping (useful for Keeper logging).
 */
module.exports = BaseResolverPlugin;
```

---

## 2. Dynamic Loading & Registration

Keepers can dynamically register and load these module-based plugins via a configuration file, allowing for extreme portability. Node operators will simply provide the location of the plugin (either a local directory or an `npm` package).

### Configuration (`plugins.json`)

A new `plugins.json` file will be supported by the Keeper to declare which resolvers to load on startup.

```json
{
  "resolvers": {
    "price-monitor": {
      "path": "./plugins/local-price-monitor",  // Local path
      "options": { 
        "threshold": 2000,
        "assetPair": "XLM/USD"
      }
    },
    "custom-api": {
      "path": "sorotask-resolver-custom-api",   // npm package
      "options": { 
        "endpoint": "https://api.example.com/check" 
      }
    }
  }
}
```

### PluginManager

A new `PluginManager` internal module will be responsible for instantiating the classes. When the Keeper starts (`index.js`), it will initialize the PluginManager, passing it the configuration map. 

```javascript
// Internal pseudo-implementation for PluginManager
class PluginManager {
  constructor() {
    this.resolvers = new Map();
  }

  async loadPlugins(pluginConfig, context) {
    for (const [name, config] of Object.entries(pluginConfig.resolvers)) {
      try {
        const PluginClass = require(config.path);
        const pluginInstance = new PluginClass();
        await pluginInstance.init(config.options, context);
        
        this.resolvers.set(name, pluginInstance);
        context.logger.info(`Successfully loaded plugin: ${name}`);
      } catch (err) {
        context.logger.error(`Failed to load plugin ${name}: ${err.message}`);
      }
    }
  }

  getResolver(name) {
    return this.resolvers.get(name);
  }
}
```

---

## 3. Integration with Poller

The current `TaskPoller` logic handles time-based and gas-based constraints. We will insert the Resolver capability as an optional, final step before placing a task into the execution queue.

### Task to Resolver Mapping
To know *which* off-chain resolver a task requires, the node operator can declare a mapping file (e.g., `task_resolvers.json`), mapping a `taskId` to a `resolver_name`.

*(Future Iteration: The SoroTask smart contract might include a `resolver` identifier field natively in the `TaskConfig` struct).*

### Control Flow
Inside `poller.js` -> `pollDueTasks(taskIds)`:

1. **Time Check**: Ensure `current_ledger_timestamp >= task.last_run + task.interval`.
2. **Gas Check**: Ensure `task.gas_balance > 0`.
3. **[NEW] Resolver Check**: 
   - Check if `taskId` maps to a registered resolver.
   - If yes, invoke `PluginManager.getResolver(name).resolve(taskId, taskConfig)`.
   - If `isReady === false`, skip execution, log `result.reason`.
   - If `isReady === true`, push the task to `dueTaskIds`. If `result.args` are provided, attach them to the execution queue payload.

```javascript
// Pseudo-code in poller.js
if (taskNeedsResolver(taskId)) {
    const resolverName = getResolverName(taskId);
    const resolver = pluginManager.getResolver(resolverName);
    
    if (resolver) {
        const result = await resolver.resolve(taskId, taskConfig);
        if (!result.isReady) {
            logger.debug(`Task ${taskId} not ready. Reason: ${result.reason}`);
            continue; // Skip execution
        }
        
        // Push task for execution with dynamic args
        dueTasks.push({ taskId, args: result.args || [] });
    }
} else {
    // Normal execution
    dueTasks.push({ taskId, args: [] });
}
```

---

## 4. Security & Considerations

1. **Trust Model**: The Keeper executes arbitrary code in the form of plugins. It is assumed that the Node Operator strictly vets and trusts any plugin running alongside their Keeper, as plugins run in the same node process.
2. **Error Boundaries**: If a plugin's `resolve()` method throws an exception or times out, the `TaskPoller` must catch the error, log a warning, and skip the task for that cycle, ensuring the main Keeper polling loop doesn't crash.
3. **Performance**: Off-chain API calls during `resolve()` must be performant. The Keeper should enforce an upper limit timeout (e.g., `5000ms`) on custom `resolve()` invocations to prevent the entire cycle from halting.
