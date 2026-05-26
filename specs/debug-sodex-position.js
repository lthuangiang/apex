// Debug script to check SoDEX position API response
const fetch = require('node-fetch');
require('dotenv').config();

const userAddress = process.env.SODEX_USER_ADDRESS;
const baseUrl = 'https://mainnet-gw.sodex.dev/api/v1/perps';

async function checkPosition() {
    const url = `${baseUrl}/accounts/${userAddress}/positions?symbol=BTC-USD`;
    console.log('Fetching:', url);
    
    const res = await fetch(url);
    const json = await res.json();
    
    console.log('\n=== Raw API Response ===');
    console.log(JSON.stringify(json, null, 2));
    
    if (json.data && Array.isArray(json.data) && json.data.length > 0) {
        const pos = json.data[0];
        console.log('\n=== Position Fields ===');
        console.log('size:', pos.size, '(type:', typeof pos.size, ')');
        console.log('avgEntryPrice:', pos.avgEntryPrice);
        console.log('unrealizedPnl:', pos.unrealizedPnl);
        
        // Calculate what the size should be
        const size = parseFloat(pos.size);
        const entryPrice = parseFloat(pos.avgEntryPrice);
        const notional = Math.abs(size) * entryPrice;
        
        console.log('\n=== Calculations ===');
        console.log('Parsed size:', size);
        console.log('Entry price:', entryPrice);
        console.log('Notional value:', notional);
        console.log('Expected fee (×2):', notional * 0.00012 * 2);
        
        // Check if size is actually notional
        if (Math.abs(size) > 1000) {
            console.log('\n⚠️  WARNING: size > 1000 suggests it might be notional value (USD), not BTC quantity!');
            console.log('If size is notional:');
            console.log('  - Actual BTC size would be:', size / entryPrice);
            console.log('  - Fee calculation would be:', size * 0.00012 * 2, '(4x too high!)');
        }
    }
}

checkPosition().catch(console.error);
