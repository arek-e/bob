import { sql } from "drizzle-orm"
import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

import { users } from "./conversations.ts"

export const gyms = pgTable("gyms", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
})

export const equipment = pgTable(
  "equipment",
  {
    id: text("id").primaryKey(),
    gymId: text("gym_id").notNull(),
    name: text("name").notNull(),
    identifier: text("identifier"),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("equipment_gym_identifier_uq").on(table.gymId, table.identifier)]
)

export const exercises = pgTable("exercises", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  instructions: text("instructions"),
  createdAt: text("created_at").notNull()
})

export const equipmentExercises = pgTable(
  "equipment_exercises",
  {
    id: text("id").primaryKey(),
    equipmentId: text("equipment_id").notNull(),
    exerciseId: text("exercise_id").notNull(),
    userApprovedAt: text("user_approved_at").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("equipment_exercises_uq").on(table.equipmentId, table.exerciseId)]
)

export const trainingProposals = pgTable(
  "training_proposals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    commandIdempotencyKey: text("command_idempotency_key").notNull(),
    proposalHash: text("proposal_hash").notNull(),
    argumentsJson: text("arguments_json").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    status: text("status", {
      enum: ["proposed", "applying", "applied", "rejected"]
    }).notNull(),
    resultJson: text("result_json"),
    approvalIdempotencyKey: text("approval_idempotency_key"),
    createdAt: text("created_at").notNull(),
    approvedAt: text("approved_at"),
    appliedAt: text("applied_at")
  },
  (table) => [
    uniqueIndex("training_proposals_run_call_uq").on(table.runId, table.toolCallId),
    uniqueIndex("training_proposals_hash_uq").on(table.proposalHash),
    uniqueIndex("training_proposals_owner_approval_uq").on(
      table.userId,
      table.approvalIdempotencyKey
    ),
    index("training_proposals_owner_state_idx").on(table.userId, table.status, table.createdAt)
  ]
)

export const routines = pgTable("routines", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  revision: integer("revision").notNull(),
  approvedAt: text("approved_at").notNull(),
  approvalSourceType: text("approval_source_type", {
    enum: ["owner_message", "owner_ui"]
  }).notNull(),
  approvalSourceId: text("approval_source_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
})

export const routineSteps = pgTable(
  "routine_steps",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id").notNull(),
    exerciseId: text("exercise_id").notNull(),
    position: integer("position").notNull(),
    targetSets: integer("target_sets"),
    targetReps: integer("target_reps"),
    notes: text("notes"),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("routine_steps_position_uq").on(table.routineId, table.position)]
)

export const workoutSessions = pgTable(
  "workout_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    routineId: text("routine_id").notNull(),
    gymId: text("gym_id"),
    status: text("status", {
      enum: ["active", "completed", "stopped_for_safety", "abandoned"]
    }).notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    index("workout_sessions_history_idx").on(table.userId, table.startedAt),
    uniqueIndex("workout_sessions_one_active_uq")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`)
  ]
)

export const workoutSets = pgTable(
  "workout_sets",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    routineStepId: text("routine_step_id").notNull(),
    equipmentId: text("equipment_id"),
    sequence: integer("sequence").notNull(),
    repetitions: integer("repetitions").notNull(),
    weightGrams: integer("weight_grams"),
    notes: text("notes"),
    painReported: boolean("pain_reported").notNull(),
    machineConfusion: boolean("machine_confusion").notNull(),
    loggedAt: text("logged_at").notNull()
  },
  (table) => [
    uniqueIndex("workout_sets_sequence_uq").on(table.sessionId, table.routineStepId, table.sequence)
  ]
)
