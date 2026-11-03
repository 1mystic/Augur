"""Train the tiny Augur square CNN with JAX and export weights for the browser."""
import sys, json, time, glob
import numpy as np, jax, jax.numpy as jnp, optax

CH = [3, 24, 48, 64]
NC = 13


def init(key):
    p = {}
    ks = jax.random.split(key, 8)
    for i in range(3):
        fan = 9 * CH[i]
        p[f'c{i}w'] = jax.random.normal(ks[i], (3, 3, CH[i], CH[i + 1])) * np.sqrt(2 / fan)
        p[f'c{i}b'] = jnp.zeros(CH[i + 1])
    p['d0w'] = jax.random.normal(ks[4], (4 * 4 * 64, 96)) * np.sqrt(2 / 1024)
    p['d0b'] = jnp.zeros(96)
    p['d1w'] = jax.random.normal(ks[5], (96, NC)) * np.sqrt(1 / 96)
    p['d1b'] = jnp.zeros(NC)
    return p


def fwd(p, x, train=False, key=None):
    for i in range(3):
        x = jax.lax.conv_general_dilated(x, p[f'c{i}w'], (1, 1), 'SAME', dimension_numbers=('NHWC', 'HWIO', 'NHWC')) + p[f'c{i}b']
        x = jax.nn.relu(x)
        x = jax.lax.reduce_window(x, -jnp.inf, jax.lax.max, (1, 2, 2, 1), (1, 2, 2, 1), 'VALID')
    x = x.reshape(x.shape[0], -1)
    x = jax.nn.relu(x @ p['d0w'] + p['d0b'])
    if train:
        x = x * jax.random.bernoulli(key, .7, x.shape) / .7
    return x @ p['d1w'] + p['d1b']


def load(files):
    Xs, Ys = [], []
    for f in files:
        d = np.load(f); Xs.append(d['X']); Ys.append(d['Y'])
    return np.concatenate(Xs), np.concatenate(Ys).astype(np.int32)


def export(p, out):
    np.savez(out + '.npz', **{k: np.asarray(v) for k, v in p.items()})
    # export: json header + float32 blob
    order = ['c0w', 'c0b', 'c1w', 'c1b', 'c2w', 'c2b', 'd0w', 'd0b', 'd1w', 'd1b']
    blob = b''.join(np.asarray(p[k], np.float32).tobytes() for k in order)
    meta = {'order': order, 'shapes': {k: list(p[k].shape) for k in order}}
    open(out + '.bin', 'wb').write(blob); json.dump(meta, open(out + '.json', 'w'))


def main():
    tr = sys.argv[1].split(','); va = sys.argv[2].split(','); epochs = int(sys.argv[3]); out = sys.argv[4]
    init_from = sys.argv[5] if len(sys.argv) > 5 else None
    X, Y = load(tr); Xv, Yv = load(va)
    print('train', X.shape, 'val', Xv.shape, flush=True)
    p = init(jax.random.PRNGKey(0))
    if init_from:
        d = np.load(init_from); p = {k: jnp.array(d[k]) for k in p}
    bs = 256; steps = epochs * (len(X) // bs)
    sched = optax.cosine_onecycle_schedule(steps, 3e-3 if not init_from else 8e-4)
    opt = optax.adamw(sched, weight_decay=1e-4); st = opt.init(p)

    def loss_fn(p, x, y, k):
        lo = fwd(p, x, True, k)
        return optax.softmax_cross_entropy_with_integer_labels(lo, y).mean()

    @jax.jit
    def step(p, st, x, y, k):
        l, g = jax.value_and_grad(loss_fn)(p, x, y, k)
        u, st = opt.update(g, st, p); return optax.apply_updates(p, u), st, l

    pred = jax.jit(lambda p, x: jnp.argmax(fwd(p, x), -1))
    norm = lambda a: jnp.asarray(a, jnp.float32) / 255.
    key = jax.random.PRNGKey(1)
    for ep in range(epochs):
        t = time.time(); perm = np.random.permutation(len(X)); ls = []
        for i in range(len(X) // bs):
            idx = perm[i * bs:(i + 1) * bs]
            xb = X[idx]
            if np.random.rand() < .5: pass
            key, k = jax.random.split(key)
            p, st, l = step(p, st, norm(xb), Y[idx], k); ls.append(float(l))
        acc = np.mean(np.concatenate([np.asarray(pred(p, norm(Xv[i:i + 2048]))) for i in range(0, len(Xv), 2048)]) == Yv)
        export(p, out)
        print(f'ep {ep} loss {np.mean(ls):.4f} val {acc:.4f} {time.time() - t:.0f}s', flush=True)
    export(p, out)


if __name__ == '__main__':
    main()
