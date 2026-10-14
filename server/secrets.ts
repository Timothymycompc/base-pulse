import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();

/**
 * Fetches a secret value from Google Secret Manager.
 * @param secretName The name of the secret (e.g., 'DATABASE_URL')
 * @returns The plaintext value of the secret
 */
async function getSecret(secretName: string): Promise<string> {
  try {
    // We assume the secret is named exactly the same as the env var
    // Format: projects/PROJECT_ID/secrets/SECRET_NAME/versions/latest
    const projectId = process.env.GCP_PROJECT_ID;
    if (!projectId) {
      throw new Error('GCP_PROJECT_ID environment variable is not set');
    }

    const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
    const [version] = await client.accessSecretVersion({ name });

    const payload = version.payload?.data?.toString();
    if (!payload) {
      throw new Error(`Secret ${secretName} was found but the payload was empty`);
    }

    return payload;
  } catch (err) {
    console.error(`Error fetching secret ${secretName} from GSM:`, err);
    throw err;
  }
}

/**
 * Loads a set of secrets and overrides process.env
 * @param secretNames Secret names to load from GSM. "ENV=SECRET" loads the secret SECRET into process.env.ENV, for
 *   secrets whose name in the shared project differs from the variable the code reads (each project's own database).
 */
export async function loadSecrets(secretNames: string[]) {
  for (const entry of secretNames) {
    const [envName, name = envName] = entry.split("=");
    try {
      const value = await getSecret(name);
      process.env[envName] = value;
      console.log(`Successfully loaded ${name} from Google Secret Manager`);
    } catch (err) {
      console.warn(`Could not load ${name} from GSM, falling back to environment variable:`, err);
    }
  }
}
