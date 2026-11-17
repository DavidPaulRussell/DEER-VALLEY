/* russl_byte20.h - the byte20 pixel of Deer Valley (law deer.valley.byte20/1) in C11.
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * One 4 m block = five 32-bit words, W0..W4 (20 bytes, 160 bits). The layout and its meaning are in
 * src/byte20.js; this header mirrors the integer parts that need no simulation: field access that never
 * sign-extends, the SWAR popcount of Theorem 2.1 of the .cmd notes (exact under arithmetic shifts because
 * bit 31 of 0x55555555, 0x33333333 and 0x0F0F0F0F is 0), the 32-way XNOR inner product, Q16.16 ticks for a
 * height change (the C037 dead-zone cure), the tied-gate GLA step and the 12-bit integer log of W4.
 * Three-metric report for one frame: 81,920 nominal words; 2,621,440 true stored bits (327,680 bytes raw);
 * rank <= 128 for each 128 x 128 word plane. */
#ifndef RUSSL_BYTE20_H
#define RUSSL_BYTE20_H
#include <stdint.h>

#define B20_BLOCKS 16384
#define B20_WORDS  5
#define B20_GLA_K  512        /* tied gate k (Q12): the trace keeps 7/8 a step */
#define B20_STRIKE_SD_Q12 7660 /* 1.87 standard deviations in Q12 */

typedef struct { int32_t w[B20_WORDS]; } russl_byte20_t;
typedef char b20_is_20_bytes[(sizeof(russl_byte20_t) == 20) ? 1 : -1];

static inline uint32_t b20_bits(int32_t x, unsigned lo, unsigned n) { return ((uint32_t)x >> lo) & ((n >= 32) ? 0xFFFFFFFFu : ((1u << n) - 1u)); }
static inline int32_t b20_put(unsigned lo, unsigned n, int32_t v) { return (int32_t)(((uint32_t)v & ((1u << n) - 1u)) << lo); }

/* Theorem 2.1: arithmetic right shift (as in cmd.exe set /a) and the masks keep the count exact */
static inline int32_t b20_popcnt32(int32_t x) {
  int32_t v1 = x - ((x >> 1) & 0x55555555);
  int32_t v2 = (v1 & 0x33333333) + ((v1 >> 2) & 0x33333333);
  int32_t v3 = (v2 + (v2 >> 4)) & 0x0F0F0F0F;
  return (int32_t)(((uint32_t)v3 * 0x01010101u) >> 24) & 0x3F;
}
static inline int32_t b20_xnor_dot32(int32_t p, int32_t q) { return (b20_popcnt32(~(p ^ q)) << 1) - 32; }

/* height change in whole millimetres -> Q16.16 metres, rounded half up: mm * 65536 / 1000 = mm * 8192 / 125 */
static inline int32_t b20_mm_to_q16(int64_t mm) {
  int64_t t = mm * 8192, q = t >= 0 ? t / 125 : -((-t + 124) / 125), r = t - q * 125;
  return (int32_t)(q + (2 * r >= 125 ? 1 : 0));
}
/* the tied-gate GLA step on a byte: S' = (S (4096 - k) + v k) >> 12 */
static inline uint32_t b20_gla_step(uint32_t s, uint32_t v, uint32_t k) { return (s * (4096u - k) + v * k) >> 12; }
/* 12-bit integer log of a non-negative 128-bit square sum given as hi:lo */
static inline uint32_t b20_log12(uint64_t hi, uint64_t lo) {
  unsigned e = 0; uint64_t top;
  if (hi) { e = 64 + (64 - (unsigned)__builtin_clzll(hi)); top = e - 6 >= 64 ? hi >> (e - 6 - 64) : (hi << (64 - (e - 6))) | (lo >> (e - 6)); }
  else if (lo) { e = 64 - (unsigned)__builtin_clzll(lo); if (e <= 5) return (uint32_t)lo; top = lo >> (e - 6); }
  else return 0;
  uint32_t v = (e << 5) | (uint32_t)(top & 31u); return v > 4095u ? 4095u : v;
}
/* parity of W0 ^ W1 ^ W2 ^ W3, stored in W4 bit 31 */
static inline uint32_t b20_parity(const russl_byte20_t *p) { return (uint32_t)b20_popcnt32(p->w[0] ^ p->w[1] ^ p->w[2] ^ p->w[3]) & 1u; }
#endif
