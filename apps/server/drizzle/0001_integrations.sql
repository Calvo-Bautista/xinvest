CREATE TABLE `integrations` (
	`provider` text PRIMARY KEY NOT NULL,
	`token_data` text,
	`last_operations_sync_at` text,
	`last_operations_sync_to` text,
	`last_prices_sync_at` text,
	`last_prices_sync_to` text,
	`last_result` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
