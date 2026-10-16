/**
 * Tasks module tables, Postgres schema `tasks` (ZACHHUB_PLAN.md §3.2). Both are first-party
 * entity tables: clients write them through /api/entities, never directly (RLS is read-only).
 * No foreign keys: rows from different devices arrive in any order, and a task may name a list
 * this server hasn't seen yet. Clients sort by `position` themselves (code-unit order).
 */
import { firstPartyColumns, ownRowsReadOnly } from '@zachhub/db/server'
import { sql } from 'drizzle-orm'
import { date, index, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const tasksSchema = pgSchema('tasks')

/** Entity 'tasks.list'. */
export const lists = tasksSchema
  .table(
    'lists',
    {
      ...firstPartyColumns(),
      name: text('name').notNull().default(''),
      color: text('color').notNull().default('gray'),
      position: text('position').notNull().default('a0'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [index('lists_user').on(t.userId), ownRowsReadOnly('lists')],
  )
  .enableRLS()

/** Entity 'tasks.task'. A reminder is a task with `alert_at`. */
export const tasks = tasksSchema
  .table(
    'tasks',
    {
      ...firstPartyColumns(),
      listId: uuid('list_id'),
      parentId: uuid('parent_id'),
      title: text('title').notNull().default(''),
      notes: text('notes').notNull().default(''),
      dueDate: date('due_date'),
      dueTime: text('due_time'),
      alertAt: timestamp('alert_at', { withTimezone: true }),
      rrule: text('rrule'),
      priority: integer('priority').notNull().default(0),
      tags: jsonb('tags').$type<string[]>().notNull().default([]),
      position: text('position').notNull().default('a0'),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      index('tasks_user_open')
        .on(t.userId, t.dueDate)
        .where(sql`${t.completedAt} IS NULL`),
      // The alert sweep (worker) reads due alerts of open tasks.
      index('tasks_alerts')
        .on(t.alertAt)
        .where(sql`${t.completedAt} IS NULL AND ${t.alertAt} IS NOT NULL`),
      ownRowsReadOnly('tasks'),
    ],
  )
  .enableRLS()
