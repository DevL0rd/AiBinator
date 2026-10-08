export function sanitizedError(message: string): Error {
    return new Error(message);
}

export class UncertainOutcome extends Error {}
