export async function maskedPrompt(label: string): Promise<string> {
    const input = process.stdin;
    if (!input.isTTY || !process.stdout.isTTY) throw new Error('Owner enrollment requires a local interactive terminal');
    process.stdout.write(label);
    input.setRawMode(true);
    input.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const finish = (error?: Error) => {
            input.off('data', onData);
            input.setRawMode(false);
            input.pause();
            process.stdout.write('\n');
            if (error) reject(error);
            else resolve(value);
        };
        const onData = (data: Buffer) => {
            for (const character of data.toString('utf8')) {
                if (character === '\u0003' || character === '\u0004') return finish(new Error('Enrollment cancelled'));
                if (character === '\r' || character === '\n') return finish();
                if (['\u007f', '\b'].includes(character)) {
                    if (value.length) {
                        value = value.slice(0, -1);
                        process.stdout.write('\b \b');
                    }
                } else if (!/[\p{C}]/u.test(character) && Buffer.byteLength(value + character) <= 1024) {
                    value += character;
                    process.stdout.write('*');
                }
            }
        };
        input.on('data', onData);
    });
}
