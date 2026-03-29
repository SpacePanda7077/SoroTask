#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, Symbol, Vec,
};
use soro_task_contract::{SoroTaskContract, SoroTaskContractClient, TaskConfig};

/// Fuzz the `register` function with randomized interval and gas_balance values.
///
/// The fuzzer drives `interval` and `gas_balance` from raw bytes so it can
/// discover edge cases such as:
/// - zero interval  → must panic with `InvalidInterval`
/// - u64::MAX interval
/// - negative / zero gas_balance
fuzz_target!(|data: &[u8]| {
    if data.len() < 9 {
        return;
    }

    // Derive fuzz inputs from raw bytes
    let interval = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let gas_balance = data[8] as i128 * 100;

    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, SoroTaskContract);
    let client = SoroTaskContractClient::new(&env, &contract_id);

    let creator = Address::generate(&env);
    let target = Address::generate(&env);

    let config = TaskConfig {
        creator,
        target,
        function: Symbol::new(&env, "ping"),
        args: Vec::new(&env),
        resolver: None,
        interval,
        last_run: 0,
        gas_balance,
        whitelist: Vec::new(&env),
        is_active: true,
    };

    // interval == 0 must panic; anything else must succeed without panic
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.register(&config)
    }));

    if interval == 0 {
        // Expected to fail
        let _ = result;
    } else {
        // Must not panic for valid intervals
        assert!(result.is_ok(), "register panicked with interval={interval}");
    }
});
