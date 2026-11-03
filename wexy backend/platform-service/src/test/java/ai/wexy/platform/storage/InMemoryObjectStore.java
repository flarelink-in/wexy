package ai.wexy.platform.storage;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * B2 for the platform's tests (W3): a bucket that keeps every version of a key, checks Content-MD5 as B2 does, and
 * erases a version by its id or every version of a key. Each call can be told to fail (B2 down), and an object can be
 * altered behind the platform's back (a corrupt read). Thread-safe, so concurrent saves can share it.
 */
public final class InMemoryObjectStore implements ObjectStore {

    private record Version(String id, byte[] bytes) {
    }

    private final Map<String, List<Version>> keys = new LinkedHashMap<>();
    private final AtomicInteger versions = new AtomicInteger();
    /** Calls of each kind still to fail, in order: put, get, delete. */
    public final AtomicInteger failPuts = new AtomicInteger();
    public final AtomicInteger failGets = new AtomicInteger();
    public final AtomicInteger failDeletes = new AtomicInteger();
    public final AtomicInteger puts = new AtomicInteger();
    public final AtomicInteger deletes = new AtomicInteger();
    /** Puts still to keep their bytes and then die as a process would, with no answer: the save is left running. */
    public final AtomicInteger crashAfterPuts = new AtomicInteger();

    /** A process that died mid-save: not a store failure, nothing the platform catches. */
    public static final class Crash extends RuntimeException {
        Crash() {
            super("the process died after the write", null, false, false);
        }
    }

    @Override
    public boolean configured() {
        return true;
    }

    @Override
    public synchronized Written put(String key, byte[] bytes, String contentType, String md5Base64) {
        if (failPuts.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
            throw new StorageUnavailable("b2 put: a stand-in failure", null);
        }
        if (!md5(bytes).equals(md5Base64)) {
            throw new StorageUnavailable("b2 put: BadDigest", null);
        }
        puts.incrementAndGet();
        String id = "v" + versions.incrementAndGet();
        keys.computeIfAbsent(key, k -> new ArrayList<>()).add(new Version(id, bytes.clone()));
        if (crashAfterPuts.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
            throw new Crash();
        }
        return new Written(id);
    }

    @Override
    public synchronized byte[] get(String key, String versionId, int maxBytes) {
        if (failGets.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
            throw new StorageUnavailable("b2 get: a stand-in failure", null);
        }
        List<Version> list = keys.get(key);
        if (list == null || list.isEmpty()) {
            return null;
        }
        Version v = versionId == null ? list.get(list.size() - 1)
                : list.stream().filter(x -> x.id().equals(versionId)).findFirst().orElse(null);
        if (v == null) {
            return null;
        }
        if (v.bytes().length > maxBytes) {
            throw new StorageUnavailable("b2 get: too large", null);
        }
        return v.bytes().clone();
    }

    @Override
    public synchronized void delete(String key, String versionId) {
        if (failDeletes.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
            throw new StorageUnavailable("b2 delete: a stand-in failure", null);
        }
        deletes.incrementAndGet();
        List<Version> list = keys.get(key);
        if (list == null) {
            return;
        }
        if (versionId == null) {
            keys.remove(key);
        } else {
            list.removeIf(v -> v.id().equals(versionId));
            if (list.isEmpty()) {
                keys.remove(key);
            }
        }
    }

    /** How many keys hold any version: what B2 would bill for. */
    public synchronized int objects() {
        return keys.size();
    }

    /** Every key held, for a test that checks where bytes went. */
    public synchronized List<String> keys() {
        return new ArrayList<>(keys.keySet());
    }

    /** Alters the newest version of `key` behind the platform's back. */
    public synchronized void corrupt(String key) {
        List<Version> list = keys.get(key);
        Version last = list.remove(list.size() - 1);
        byte[] bytes = last.bytes().clone();
        bytes[bytes.length / 2] ^= 1;
        list.add(new Version(last.id(), bytes));
    }

    private static String md5(byte[] bytes) {
        try {
            return Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
