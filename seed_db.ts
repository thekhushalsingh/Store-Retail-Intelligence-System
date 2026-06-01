import { Client } from 'pg';
import dotenv from "dotenv";

dotenv.config();

const connectionString = process.env.DATABASE_URL;

async function seedData() {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    
    // clear all tables
    await client.query(`DELETE FROM transactions`);
    await client.query(`DELETE FROM events`);
    
    // insert 150 events for store STORE_001 for "today"
    console.log("Seeding data...");
    
    const store_id = 'STORE_001';
    
    for (let i = 0; i < 30; i++) {
        const vid = `VIS_${Math.floor(Math.random() * 10000)}`;
        const baseTime = new Date();
        baseTime.setHours(baseTime.getHours() - Math.floor(Math.random() * 10)); // past 10 hours
        
        // ENTRY
        await client.query(`
        INSERT INTO events (event_id, store_id, visitor_id, event_type, timestamp, confidence)
        VALUES (gen_random_uuid(), $1, $2, 'ENTRY', $3, 0.95)`, [store_id, vid, baseTime.toISOString()]);
        
        // Sometimes they visit a zone
        if (Math.random() > 0.2) {
            const zones = ['SKINCARE', 'FRAGRANCE', 'MAKEUP'];
            const z = zones[Math.floor(Math.random() * zones.length)];
            const timeInZone = new Date(baseTime.getTime() + 1000 * 60 * 2);
            await client.query(`
                INSERT INTO events (event_id, store_id, visitor_id, event_type, timestamp, zone_id, dwell_ms, confidence)
                VALUES (gen_random_uuid(), $1, $2, 'ZONE_DWELL', $3, $4, $5, 0.9)`, 
                [store_id, vid, timeInZone.toISOString(), z, Math.floor(Math.random() * 600000)]);
                
            // Sometimes they join billing
            if (Math.random() > 0.4) {
                 const billingTime = new Date(timeInZone.getTime() + 1000 * 60 * 5);
                 await client.query(`
                    INSERT INTO events (event_id, store_id, visitor_id, event_type, timestamp, zone_id, confidence, metadata)
                    VALUES (gen_random_uuid(), $1, $2, 'BILLING_QUEUE_JOIN', $3, 'BILLING', 0.9, '{"queue_depth": 4}'::jsonb)`,
                    [store_id, vid, billingTime.toISOString()]);
                    
                // Sometimes they purchase
                if (Math.random() > 0.2) {
                    await client.query(`
                    INSERT INTO transactions (transaction_id, store_id, timestamp, basket_value)
                    VALUES (gen_random_uuid(), $1, $2, $3)`,
                    [store_id, billingTime.toISOString(), 150.50]);
                }
            }
        }
    }
    
    // insert some anomalies
    await client.query(`DELETE FROM anomalies`);
    await client.query(`
      INSERT INTO anomalies (store_id, type, severity, timestamp, suggested_action)
      VALUES ($1, 'QUEUE_SPIKE', 'WARN', $2, 'Wait times exceeded threshold. Open more registers.')
    `, [store_id, new Date().toISOString()]);
    
    console.log("Seeding complete!");
  } catch(e) {
    console.error(e);
  } finally {
    await client.end();
  }
}
seedData();
