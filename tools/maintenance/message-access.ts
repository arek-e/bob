import { MaintenanceCliError } from "./cli.js"

export const DEFAULT_OWNER_ID_ENVIRONMENT = "BOB_OWNER_ID"
export const DEFAULT_APPROVAL_ENVIRONMENT = "BOB_MAINTENANCE_CONTENT_APPROVAL"
export const CONTENT_APPROVAL = "owner-approved"

export function readApprovedOwner(
  env: NodeJS.ProcessEnv,
  ownerIdEnvironment: string,
  approvalEnvironment: string
): string {
  const ownerId = requiredEnvironmentName(env, ownerIdEnvironment, "Owner ID")
  validateEnvironmentName(approvalEnvironment, "Approval")
  if (env[approvalEnvironment] !== CONTENT_APPROVAL) {
    throw new MaintenanceCliError(
      `Owner content access requires ${approvalEnvironment}=owner-approved`
    )
  }
  return ownerId
}

function requiredEnvironmentName(env: NodeJS.ProcessEnv, name: string, label: string): string {
  validateEnvironmentName(name, label)
  const value = env[name]
  if (value === undefined || value.length === 0) {
    throw new MaintenanceCliError(`${label} is missing`)
  }
  return value
}

export function validateEnvironmentName(name: string, label: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
    throw new MaintenanceCliError(`${label} environment name is invalid`)
  }
}
