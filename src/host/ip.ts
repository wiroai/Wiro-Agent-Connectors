import net from 'node:net';

// Which addresses a media download may connect to: public unicast only. No
// loopback, private, link-local, carrier-grade NAT, documentation, multicast or
// reserved ranges, in IPv4 or IPv6. IPv4-mapped IPv6 addresses are checked
// against the IPv4 rules (net.BlockList does that itself).

const blocked = new net.BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(address, prefix, 'ipv4');
}

for (const [address, prefix] of [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible range
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments, Teredo included
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

/** The 8 groups of an IPv6 address, or undefined. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = (dotted[1] as string).split('.').map(Number);
    text = `${text.slice(0, -(dotted[1] as string).length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill('0'), ...right].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

export function isPublicAddress(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  if (blocked.check(address, 'ipv6')) return false;
  const groups = ipv6Groups(address.toLowerCase());
  if (!groups) return false;
  // NAT64 (64:ff9b::/96) carries an IPv4 address: judge that one.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    const [high = 0, low = 0] = groups.slice(6);
    return isPublicAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return true;
}
