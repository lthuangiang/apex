/**
 * Helper script: Get and pad builder address for Decibel DEX.
 * 
 * Decibel requires builder addresses to be 64 hex characters (66 total with 0x).
 * This script helps you format your address correctly.
 * 
 * Usage: 
 *   npx tsx src/scripts/get-builder-address.ts
 *   npx tsx src/scripts/get-builder-address.ts 0x8c967e73e7b15087c42a10d344cff4c96d877f1d
 */
import 'dotenv/config';
import { Ed25519Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';

/**
 * Pad Aptos address to 64 hex characters (66 total with 0x prefix)
 */
function padAddress(addr: string): string {
    if (!addr) throw new Error('Address is required');
    
    // Remove 0x prefix if present
    let hex = addr.startsWith('0x') ? addr.slice(2) : addr;
    
    // Validate hex
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error('Invalid hex address: ' + addr);
    }
    
    // Check length
    if (hex.length > 64) {
        throw new Error('Address too long (max 64 hex chars): ' + hex.length);
    }
    
    // Pad with leading zeros
    return '0x' + hex.padStart(64, '0');
}

async function main() {
    console.log('\n🔧 Decibel Builder Address Helper\n');
    
    // Get address from command line or env
    const inputAddr = process.argv[2] || process.env.API_WALLET_ADDRESS;
    
    if (inputAddr) {
        // Pad provided address
        console.log('Input address:', inputAddr);
        const padded = padAddress(inputAddr);
        console.log('Padded address:', padded);
        console.log('\n✅ Use this address in your .env:');
        console.log(`BUILDER_ADDRESS=${padded}`);
    } else if (process.env.API_WALLET_PRIVATE_KEY) {
        // Derive from private key
        console.log('Deriving address from API_WALLET_PRIVATE_KEY...\n');
        
        const cleanKey = (val: string) => {
            let res = val.trim();
            while (res.startsWith('ed25519-priv-') || res.startsWith('0x')) {
                res = res.replace(/^ed25519-priv-/, '').replace(/^0x/, '');
            }
            return res;
        };
        
        const account = new Ed25519Account({
            privateKey: new Ed25519PrivateKey(cleanKey(process.env.API_WALLET_PRIVATE_KEY)),
        });
        
        const rawAddr = account.accountAddress.toString();
        const paddedAddr = padAddress(rawAddr);
        
        console.log('Raw address:', rawAddr);
        console.log('Padded address:', paddedAddr);
        console.log('\n✅ Use this address in your .env:');
        console.log(`BUILDER_ADDRESS=${paddedAddr}`);
    } else {
        console.error('❌ No address provided!');
        console.log('\nUsage:');
        console.log('  1. Provide address as argument:');
        console.log('     npx tsx src/scripts/get-builder-address.ts 0x8c967e73...');
        console.log('\n  2. Or set API_WALLET_PRIVATE_KEY in .env');
        console.log('     npx tsx src/scripts/get-builder-address.ts');
        process.exit(1);
    }
    
    console.log('\n📝 Notes:');
    console.log('  • Builder address must be 64 hex chars (66 with 0x)');
    console.log('  • Pad with leading zeros if shorter');
    console.log('  • Builder fees will be paid to this address');
    console.log('  • You can use API Wallet address or a separate address\n');
}

main().catch(e => {
    console.error('\n💥 Error:', e.message);
    process.exit(1);
});
