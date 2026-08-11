CREATE TABLE `auth_user` (
  `id` text NOT NULL PRIMARY KEY,
  `name` text NOT NULL,
  `email` text NOT NULL UNIQUE,
  `email_verified` integer NOT NULL,
  `image` text,
  `created_at` date NOT NULL,
  `updated_at` date NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_session` (
  `id` text NOT NULL PRIMARY KEY,
  `expires_at` date NOT NULL,
  `token` text NOT NULL UNIQUE,
  `created_at` date NOT NULL,
  `updated_at` date NOT NULL,
  `ip_address` text,
  `user_agent` text,
  `user_id` text NOT NULL REFERENCES `auth_user` (`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `auth_account` (
  `id` text NOT NULL PRIMARY KEY,
  `account_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `user_id` text NOT NULL REFERENCES `auth_user` (`id`) ON DELETE CASCADE,
  `access_token` text,
  `refresh_token` text,
  `id_token` text,
  `access_token_expires_at` date,
  `refresh_token_expires_at` date,
  `scope` text,
  `password` text,
  `created_at` date NOT NULL,
  `updated_at` date NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_verification` (
  `id` text NOT NULL PRIMARY KEY,
  `identifier` text NOT NULL,
  `value` text NOT NULL,
  `expires_at` date NOT NULL,
  `created_at` date NOT NULL,
  `updated_at` date NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_rate_limit` (
  `id` text NOT NULL PRIMARY KEY,
  `key` text NOT NULL UNIQUE,
  `count` integer NOT NULL,
  `last_request` bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_session_user_id_idx` ON `auth_session` (`user_id`);
--> statement-breakpoint
CREATE INDEX `auth_account_user_id_idx` ON `auth_account` (`user_id`);
--> statement-breakpoint
CREATE INDEX `auth_verification_identifier_idx` ON `auth_verification` (`identifier`);
