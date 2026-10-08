export interface Principal {
    id: string;
    expiresAt?: number;
}

export function requireOwner(principal?: Principal): void {
    if (!principal) throw new Error('Authenticated owner required');
}
