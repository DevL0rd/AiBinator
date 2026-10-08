import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Authenticator } from '../src/mcp/auth.js';
import { fakeConfig } from './fixtures.js';

export async function checkAuth(): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const config = {
        ...fakeConfig(),
        AIBINATOR_AUTH_MODE: 'oauth' as const,
        AIBINATOR_RESOURCE_URL: 'https://aibinator.example/mcp',
        AIBINATOR_OAUTH_ISSUER: 'https://issuer.example',
        AIBINATOR_OAUTH_JWKS_URL: 'https://issuer.example/jwks',
        AIBINATOR_OAUTH_SUBJECTS: 'owner',
    };
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'validation', alg: 'RS256' }] });
    const auth = new Authenticator(config, keys);
    const accepts = (token: string) => auth.accepts({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage);
    const token = (
        scope = 'aibinator:control',
        subject = 'owner',
        audience = config.AIBINATOR_RESOURCE_URL,
        issuer = config.AIBINATOR_OAUTH_ISSUER,
    ) =>
        new SignJWT({ scope })
            .setProtectedHeader({ alg: 'RS256', kid: 'validation' })
            .setSubject(subject)
            .setAudience(audience)
            .setIssuer(issuer)
            .setIssuedAt()
            .setExpirationTime('1m')
            .sign(privateKey);
    assert.equal(await accepts(await token()), true);
    assert.equal(await accepts(await token('other:scope')), false);
    assert.equal(await accepts(await token('aibinator:control', 'stranger')), false);
    assert.equal(await accepts(await token('aibinator:control', 'owner', 'https://other.example/mcp')), false);
    assert.equal(await accepts(await token('aibinator:control', 'owner', config.AIBINATOR_RESOURCE_URL, 'https://wrong.example')), false);
    assert.equal(await accepts('invalid.signature.value'), false);
    const expired = await new SignJWT({ scope: 'aibinator:control' })
        .setProtectedHeader({ alg: 'RS256', kid: 'validation' })
        .setSubject('owner')
        .setAudience(config.AIBINATOR_RESOURCE_URL)
        .setIssuer(config.AIBINATOR_OAUTH_ISSUER)
        .setIssuedAt()
        .setExpirationTime(1)
        .sign(privateKey);
    assert.equal(await accepts(expired), false);
    assert.equal(auth.metadata().resource, config.AIBINATOR_RESOURCE_URL);
    assert.ok(auth.challenge().includes('resource_metadata='));
    assert.equal(await auth.authenticate({ headers: {} } as IncomingMessage), null, 'Authentication is always required');
}
