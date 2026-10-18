CREATE TABLE `shops` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`subtitle` text NOT NULL,
	`menu` text NOT NULL,
	`settings` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shops_owner_idx` ON `shops` (`owner_id`);