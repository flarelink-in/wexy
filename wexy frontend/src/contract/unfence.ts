// The fence rule (the backend's forge-loop design §5.2; its CodeBlocks.unfence is the same four lines). The
// templates ask for the function alone, with no code fence; when a model fences it anyway, the first fenced block
// is the answer and the rest is dropped. Both sides apply the same rule to the same recorded text, so the lines a
// repair names are the lines the server shows the model. Text with no fence comes back unchanged; a block the
// stream cut before its closing fence runs to the end.

const FENCE = '```';

const isFence = (line: string) => line.trimStart().startsWith(FENCE);

export function unfence(text: string): string {
    const lines = text.split('\n');
    const open = lines.findIndex(isFence);
    if (open < 0) return text;
    const block: string[] = [];
    for (let i = open + 1; i < lines.length && !isFence(lines[i]); i++) block.push(lines[i]);
    return block.join('\n');
}
