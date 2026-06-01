import { Client } from 'pg';

const connectionString = "postgresql://neondb_owner:npg_RX72UKNdwyAv@ep-jolly-bread-apwf6kyo-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

async function createSchema() {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    console.log("Connected to Neon DB.");

    await client.query(`
      CREATE TABLE IF NOT EXISTS stores (
          id VARCHAR PRIMARY KEY,
          name VARCHAR
      );

      CREATE TABLE IF NOT EXISTS events (
          event_id UUID PRIMARY KEY,
          store_id VARCHAR,
          camera_id VARCHAR,
          visitor_id VARCHAR,
          event_type VARCHAR,
          timestamp TIMESTAMPTZ,
          zone_id VARCHAR,
          dwell_ms INTEGER DEFAULT 0,
          is_staff BOOLEAN DEFAULT FALSE,
          confidence FLOAT,
          metadata JSONB DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS ix_events_store_id ON events (store_id);
      CREATE INDEX IF NOT EXISTS ix_events_visitor_id ON events (visitor_id);
      CREATE INDEX IF NOT EXISTS ix_events_event_type ON events (event_type);
      CREATE INDEX IF NOT EXISTS ix_events_timestamp ON events (timestamp);

      CREATE TABLE IF NOT EXISTS transactions (
          transaction_id VARCHAR PRIMARY KEY,
          store_id VARCHAR,
          timestamp TIMESTAMPTZ,
          basket_value FLOAT
      );
      CREATE INDEX IF NOT EXISTS ix_transactions_store_id ON transactions (store_id);
      CREATE INDEX IF NOT EXISTS ix_transactions_timestamp ON transactions (timestamp);

      CREATE TABLE IF NOT EXISTS anomalies (
          id SERIAL PRIMARY KEY,
          store_id VARCHAR,
          type VARCHAR,
          severity VARCHAR,
          timestamp TIMESTAMPTZ,
          suggested_action VARCHAR
      );
      CREATE INDEX IF NOT EXISTS ix_anomalies_store_id ON anomalies (store_id);
    `);
    console.log("Schema created successfully!");
  } catch (err) {
    console.error("Error creating schema", err);
  } finally {
    await client.end();
  }
}

createSchema();
