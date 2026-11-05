CREATE TABLE `fx_rates` (
	`date` text NOT NULL,
	`pair` text NOT NULL,
	`rate` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	PRIMARY KEY(`date`, `pair`, `source`)
);
--> statement-breakpoint
CREATE TABLE `instruments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`name` text,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`price_divisor` text DEFAULT '1' NOT NULL,
	`cedear_ratio` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "instruments_type_chk" CHECK("instruments"."type" IN ('STOCK','CEDEAR','BOND','ON','FCI','CAUCION','OTHER')),
	CONSTRAINT "instruments_currency_chk" CHECK("instruments"."currency" IN ('ARS','USD_MEP','USD_CCL'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instruments_ticker_unique` ON `instruments` (`ticker`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`instrument_id` integer,
	`quantity` text,
	`unit_price` text,
	`amount` text,
	`currency` text NOT NULL,
	`commission` text DEFAULT '0' NOT NULL,
	`market_fees` text DEFAULT '0' NOT NULL,
	`taxes` text DEFAULT '0' NOT NULL,
	`notes` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`external_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "operations_shape_chk" CHECK((
        ("operations"."type" IN ('BUY','SELL') AND "operations"."instrument_id" IS NOT NULL AND "operations"."quantity" IS NOT NULL AND "operations"."unit_price" IS NOT NULL AND "operations"."amount" IS NULL)
        OR ("operations"."type" IN ('DIVIDEND','COUPON','AMORTIZATION') AND "operations"."instrument_id" IS NOT NULL AND "operations"."amount" IS NOT NULL AND "operations"."quantity" IS NULL AND "operations"."unit_price" IS NULL)
        OR ("operations"."type" IN ('DEPOSIT','WITHDRAWAL') AND "operations"."instrument_id" IS NULL AND "operations"."amount" IS NOT NULL AND "operations"."quantity" IS NULL AND "operations"."unit_price" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_external_id_unique` ON `operations` (`external_id`);--> statement-breakpoint
CREATE INDEX `operations_date_idx` ON `operations` (`date`);--> statement-breakpoint
CREATE INDEX `operations_instrument_idx` ON `operations` (`instrument_id`);--> statement-breakpoint
CREATE TABLE `prices` (
	`instrument_id` integer NOT NULL,
	`date` text NOT NULL,
	`price` text NOT NULL,
	`currency` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	PRIMARY KEY(`instrument_id`, `date`, `source`),
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
