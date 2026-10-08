import { requestOwnerPassword } from '../src/oauth/provision.js';
import { maskedPrompt } from './oauth-prompt.js';
import { oauthDirectory } from '../src/oauth/registration.js';

try {
    const password = await maskedPrompt('Sign-in password (masked, at least 12 characters): ');
    const confirmation = await maskedPrompt('Confirm password (masked): ');
    if (password !== confirmation) throw new Error('Passwords do not match');
    await requestOwnerPassword(oauthDirectory.parse(process.env.AIBINATOR_OAUTH_DATA_DIR), password);
    console.log('Password saved. Only its Argon2id hash is stored; AiBinator applies it right away, or on its next start.');
} catch (error) {
    console.error(error instanceof Error ? error.message : 'Setting the password failed.');
    process.exitCode = 1;
}
