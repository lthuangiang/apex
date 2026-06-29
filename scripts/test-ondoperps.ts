#!/usr/bin/env tsx

/**
 * Manual test script for OndoPerps adapter
 * Usage: tsx scripts/test-ondoperps.ts
 */

import { OndoPerpsAdapter } from '../src/adapters/ondoperps_adapter.js';
import * as dotenv from 'dotenv';

dotenv.config();

async function testOndoPerps() {
  console.log('🚀 Starting OndoPerps Adapter Tests\n');

  const adapter = new OndoPerpsAdapter({
    apiKeyId: process.env.ONDOPERPS_API_KEY_ID!,
    apiKeySecret: process.env.ONDOPERPS_API_KEY_SECRET!,
    baseUrl: process.env.ONDOPERPS_BASE_URL
  });

  try {
    // Test 1: Connect and fetch markets
    console.log('📡 Test 1: Connecting and fetching markets...');
    await adapter.connect();
    console.log('✅ Connected successfully');
    console.log(`✅ Found ${adapter.supportedSymbols.length} markets`);
    console.log('   First 5 symbols:', adapter.supportedSymbols.slice(0, 5));
    console.log('');

    // Test 2: Get balance
    console.log('💰 Test 2: Fetching balance...');
    const balance = await adapter.getBalance();
    console.log('✅ Balance retrieved:');
    console.log(`   Total: ${balance.total} ${balance.currency}`);
    console.log(`   Available: ${balance.available} ${balance.currency}`);
    console.log('');

    // Test 3: Get positions
    console.log('📊 Test 3: Fetching positions...');
    const positions = await adapter.getPositions();
    console.log(`✅ Found ${positions.length} positions`);
    if (positions.length > 0) {
      positions.forEach(pos => {
        console.log(`   ${pos.symbol}: ${pos.side} ${pos.size} @ ${pos.entryPrice}`);
        console.log(`     PnL: ${pos.unrealizedPnl}, Leverage: ${pos.leverage}x`);
      });
    } else {
      console.log('   No open positions');
    }
    console.log('');

    // Test 4: Get open orders
    console.log('📝 Test 4: Fetching open orders...');
    const orders = await adapter.getOpenOrders();
    console.log(`✅ Found ${orders.length} open orders`);
    if (orders.length > 0) {
      orders.forEach(order => {
        console.log(`   ${order.symbol}: ${order.side} ${order.size} @ ${order.price}`);
        console.log(`     Status: ${order.status}, Filled: ${order.filledSize}`);
      });
    } else {
      console.log('   No open orders');
    }
    console.log('');

    // Test 5: Place and cancel test order (COMMENTED OUT - uncomment to test)
    /*
    console.log('⚠️  Test 5: Placing test order (small, far from market)...');
    const testOrder = await adapter.placeOrder({
      symbol: 'XAU-PERP',
      side: 'long',
      type: 'LIMIT',
      price: 1000,  // Far below market to avoid fill
      size: 0.01    // Minimum size
    });
    console.log('✅ Order placed:', testOrder.id);
    console.log(`   ${testOrder.symbol}: ${testOrder.side} ${testOrder.size} @ ${testOrder.price}`);

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('🗑️  Cancelling test order...');
    await adapter.cancelOrder(testOrder.id);
    console.log('✅ Order cancelled successfully');
    console.log('');
    */

    // Test 6: Connection health
    console.log('❤️  Test 6: Checking connection health...');
    const health = adapter.getConnectionHealth();
    console.log('✅ Connection health:');
    console.log(`   Connected: ${health.isConnected}`);
    console.log(`   Latency: ${health.latency}ms`);
    console.log('');

    console.log('🎉 All tests completed successfully!\n');

  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response:', error.response.data);
    }
    process.exit(1);
  } finally {
    await adapter.disconnect();
  }
}

// Run tests
testOndoPerps().catch(console.error);
