const changed = async(a, b, o = {}) => {
    const fs = require("fs");
    const f = require("fs/promises");
    const p = require("path");
    const c = require("crypto");
    const exts = (o.ext || [".js", ".htm", ".html", ".css", ".json", ".jsx", ".svg"])
        .map(e => e.toLowerCase());
    const hashFile = x => new Promise((resolve, reject) => {
        const h = c.createHash("sha256");
        fs.createReadStream(x)
            .on("error", reject)
            .on("data", d => h.update(d))
            .on("end", () => resolve(h.digest("hex")));
    });
    const walk = async root => {
        const base = p.resolve(root);
        const queue = [base];
        const out = new Map();
        let active = 0;
        await new Promise((resolve, reject) => {
            const next = () => {
                if (!queue.length && !active) return resolve();
                while (queue.length && active < Math.max(1, Math.min(64, o.concurrency || 32))) {
                    active++;
                    (dir =>
                        f.readdir(dir, {
                            withFileTypes: true
                        })
                        .then(entries => Promise.all(entries.map(async e => {
                            const full = p.join(dir, e.name);
                            const key = p.relative(base, full).split(p.sep).join("/");
                            if ((o.ignore || [
                                    /(^|\/)\.git(\/|$)/,
                                    /(^|\/)node_modules(\/|$)/,
                                    /(^|\/)\.history(\/|$)/,
                                    /(^|\/)build(\/|$)/,
                                    /(^|\/)\.DS_Store$/,
                                    /(^|\/)vendor(\/|$)/
                                ]).some(r => r.test(key))) return;
                            if (e.isDirectory()) {
                                if (dir === base ? (o.dirs || ["scripts", "jsx", "icons", "host", "client"]).includes(e.name) : true) queue.push(full);
                                return;
                            }
                            if (!e.isFile() ||
                                exts.length && !exts.includes(p.extname(e.name).toLowerCase())
                            ) {
                                return;
                            }
                            const s = await f.stat(full);
                            out.set(key, {
                                path: full,
                                size: s.size,
                                mtime: Math.round(s.mtimeMs)
                            });
                        })))
                        .then(() => {
                            active--;
                            next();
                        })
                        .catch(reject)
                    )(queue.pop());
                }
            };
            next();
        });
        return out;
    };
    const [A, B] = await Promise.all([walk(a), walk(b)]);
    if (A.size !== B.size) return true;
    for (const [key, x] of A) {
        const y = B.get(key);
        if (!y || x.size !== y.size || x.mtime !== y.mtime) return true;
    }
    if (o.hash) {
        for (const [key, x] of A) {
            if (await hashFile(x.path) !== await hashFile(B.get(key).path)) return true;
        }
    }
    return false;
};
module.exports = {
    changed
};