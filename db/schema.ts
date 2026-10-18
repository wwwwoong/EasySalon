import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const shops = sqliteTable('shops', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  name: text('name').notNull(),
  subtitle: text('subtitle').notNull(),
  menu: text('menu').notNull(),
  settings: text('settings').notNull(),
  state: text('state').notNull(),
  revision: integer('revision').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('shops_owner_idx').on(t.ownerId)]);

export const platformSettings = sqliteTable('platform_settings', {key:text('key').primaryKey(),value:text('value').notNull()});
