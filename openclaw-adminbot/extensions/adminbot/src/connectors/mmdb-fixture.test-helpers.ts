// Builds a tiny, synthetic MaxMind-format (.mmdb) city database in memory, so the local-database
// geolocator is tested against the real mmdb-lib reader without shipping or downloading a real
// database. Only what the reader needs: an IPv4 search tree with 24-bit records, the data section,
// and the metadata block (MaxMind DB format spec, version 2.0).
//
// The networks and places are invented for tests and documentation-range addresses are used where
// possible; nothing here is derived from a real database.

type MmdbValue =
  | string
  | number
  | { kind: "double"; value: number }
  | { kind: "uint64"; value: bigint }
  | MmdbValue[]
  | { [key: string]: MmdbValue };

function control(type: number, size: number): Buffer {
  if (size >= 29) {
    throw new Error("fixture values are kept under 29 bytes/entries");
  }
  // Types above 7 are "extended": type 0 in the control byte, then (type - 7) in the next byte.
  return type <= 7 ? Buffer.from([(type << 5) | size]) : Buffer.from([size, type - 7]);
}

function uint(value: number | bigint, type: number): Buffer {
  const bytes: number[] = [];
  let rest = BigInt(value);
  while (rest > 0n) {
    bytes.unshift(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return Buffer.concat([control(type, bytes.length), Buffer.from(bytes)]);
}

function encode(value: MmdbValue): Buffer {
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([control(2, bytes.length), bytes]);
  }
  if (typeof value === "number") {
    return uint(value, value > 0xffff ? 6 : 5);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([control(11, value.length), ...value.map(encode)]);
  }
  if (value.kind === "double" && typeof value.value === "number") {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value.value);
    return Buffer.concat([control(3, 8), bytes]);
  }
  if (value.kind === "uint64" && typeof value.value === "bigint") {
    return uint(value.value, 9);
  }
  const entries = Object.entries(value as Record<string, MmdbValue>);
  return Buffer.concat([
    control(7, entries.length),
    ...entries.flatMap(([key, entry]) => [encode(key), encode(entry)]),
  ]);
}

/** One synthetic place, in the GeoIP2 city layout DB-IP and MaxMind both use. */
export type FixtureCity = {
  city?: string;
  region?: string;
  country: string;
  continent: string;
  timeZone?: string;
  latitude?: number;
  longitude?: number;
};

function cityRecord(place: FixtureCity): MmdbValue {
  return {
    ...(place.city ? { city: { names: { en: place.city } } } : {}),
    continent: { code: place.continent },
    country: { iso_code: place.country },
    ...(place.region ? { subdivisions: [{ names: { en: place.region } }] } : {}),
    location: {
      latitude: { kind: "double", value: place.latitude ?? 0 },
      longitude: { kind: "double", value: place.longitude ?? 0 },
      ...(place.timeZone ? { time_zone: place.timeZone } : {}),
    },
  };
}

type TrieNode = { children: [TrieNode | number | undefined, TrieNode | number | undefined] };

/**
 * Builds the database. `networks` maps an IPv4 CIDR ("203.0.113.0/24") to the place it locates.
 */
export function buildCityMmdb(networks: Record<string, FixtureCity>): Buffer {
  const dataParts: Buffer[] = [];
  let dataLength = 0;
  const root: TrieNode = { children: [undefined, undefined] };
  for (const [cidr, place] of Object.entries(networks)) {
    const [address = "", bitsText = "32"] = cidr.split("/");
    const bits = Number(bitsText);
    const ip = address.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
    const encoded = encode(cityRecord(place));
    const offset = dataLength;
    dataParts.push(encoded);
    dataLength += encoded.length;
    let node = root;
    for (let depth = 0; depth < bits; depth += 1) {
      const bit = ((ip >>> (31 - depth)) & 1) as 0 | 1;
      if (depth === bits - 1) {
        node.children[bit] = offset;
        break;
      }
      const next = node.children[bit];
      if (typeof next !== "object") {
        const child: TrieNode = { children: [undefined, undefined] };
        node.children[bit] = child;
        node = child;
      } else {
        node = next;
      }
    }
  }
  // Number the nodes breadth-first; node 0 is the root. The array iterator re-reads the length,
  // so nodes pushed during the walk are visited too.
  const order: TrieNode[] = [root];
  for (const node of order) {
    for (const child of node.children) {
      if (child && typeof child === "object") {
        order.push(child);
      }
    }
  }
  const nodeCount = order.length;
  const tree = Buffer.alloc(nodeCount * 6);
  order.forEach((node, index) => {
    node.children.forEach((child, side) => {
      const value =
        child === undefined
          ? nodeCount // "no data here"
          : typeof child === "number"
            ? nodeCount + 16 + child // a pointer into the data section
            : order.indexOf(child);
      tree.writeUIntBE(value, index * 6 + side * 3, 3);
    });
  });
  const metadata = encode({
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: { kind: "uint64", value: 1_760_000_000n },
    database_type: "AdminBot-Test-City",
    description: { en: "Synthetic test fixture" },
    ip_version: 4,
    languages: ["en"],
    node_count: nodeCount,
    record_size: 24,
  });
  return Buffer.concat([
    tree,
    Buffer.alloc(16),
    ...dataParts,
    Buffer.from([0xab, 0xcd, 0xef]),
    Buffer.from("MaxMind.com", "ascii"),
    metadata,
  ]);
}
