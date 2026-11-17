/* byte20_check.c - checks a byte20 frame and writes it as packed hex .cmd lines.
 * SPDX-License-Identifier: GPL-3.0-only
 *   cc -std=c11 -O2 -o byte20_check byte20_check.c
 *   ./byte20_check --selftest
 *   ./byte20_check frame.b20 [out.cmd]   (frame.b20: five 128 x 128 little-endian int32 word planes, W0..W4)
 * The .cmd output packs 12 pixels (60 words) and 4 audit words per set line, 512 hex digits: the packed
 * hex stream of the .cmd notes (8.5 ASCII bytes a word against 37 for one integer per set line). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "russl_byte20.h"

static int selftest(void) {
  int bad = 0; uint32_t s = 0x9E3779B9u;
  for (int k = 0; k < 1000000; k++) { s = s * 1664525u + 1013904223u; int32_t x = (int32_t)s; if (b20_popcnt32(x) != __builtin_popcount((uint32_t)x)) bad++; }
  if (b20_popcnt32(-1) != 32 || b20_popcnt32(INT32_MIN) != 1 || b20_xnor_dot32(12345, 12345) != 32 || b20_xnor_dot32(7, ~7) != -32) bad++;
  if (b20_mm_to_q16(1) != 66 || b20_mm_to_q16(-1) != -66 || b20_mm_to_q16(0) != 0) bad++;     /* 1 mm = 65.536 ticks */
  if (b20_gla_step(0, 255, B20_GLA_K) != 31 || b20_gla_step(255, 255, B20_GLA_K) != 255) bad++;
  if (b20_log12(0, 0) != 0 || b20_log12(0, 1ull << 40) != 1312 || b20_log12(1, 0) != ((65u << 5) | 0)) bad++;
  printf("%s  SWAR popcount = hardware popcount on 1,000,000 words (bit 31 included); XNOR dot, Q16.16, GLA and log12 vectors\n", bad ? "FAIL" : "PASS");
  return bad ? 1 : 0;
}
int main(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "--selftest")) return selftest();
  if (argc < 2) { fprintf(stderr, "usage: byte20_check --selftest | frame.b20 [out.cmd]\n"); return 2; }
  FILE *f = fopen(argv[1], "rb"); if (!f) { perror(argv[1]); return 2; }
  static int32_t planes[B20_WORDS * B20_BLOCKS];
  size_t n = fread(planes, sizeof(int32_t), B20_WORDS * B20_BLOCKS, f); fclose(f);
  if (n != (size_t)B20_WORDS * B20_BLOCKS) { fprintf(stderr, "%s: expected %d words, read %zu\n", argv[1], B20_WORDS * B20_BLOCKS, n); return 2; }
  static russl_byte20_t px[B20_BLOCKS];
  for (int c = 0; c < B20_BLOCKS; c++) for (int m = 0; m < B20_WORDS; m++) px[c].w[m] = planes[m * B20_BLOCKS + c];   /* little-endian hosts */
  long badParity = 0, deer = 0, wolves = 0, latched = 0;
  for (int c = 0; c < B20_BLOCKS; c++) {
    if (b20_bits(px[c].w[4], 31, 1) != b20_parity(&px[c])) badParity++;
    deer += b20_bits(px[c].w[2], 0, 6); wolves += b20_bits(px[c].w[2], 14, 3); latched += b20_bits(px[c].w[4], 30, 1);
  }
  printf("%s  %d blocks: parity bits %s; %ld deer, %ld wolves counted in W2; %ld latched blocks\n", badParity ? "FAIL" : "PASS", B20_BLOCKS, badParity ? "disagree" : "agree", deer, wolves, latched);
  if (argc >= 3) {
    FILE *o = fopen(argv[2], "wb"); if (!o) { perror(argv[2]); return 2; }
    fprintf(o, "@echo off\r\n:: byte20 frame as packed hex: 12 pixels + 4 audit words per line (512 hex digits)\r\n");
    for (int line = 0; line * 12 < B20_BLOCKS; line++) {
      uint32_t audit[4] = { 0, 0, 0, 0 };
      fprintf(o, "set \"B20_L%04d=", line);
      for (int p = 0; p < 12; p++) { int c = line * 12 + p; for (int m = 0; m < B20_WORDS; m++) { uint32_t w = c < B20_BLOCKS ? (uint32_t)px[c].w[m] : 0u; fprintf(o, "%08X", w); audit[m % 4] ^= w; } }
      fprintf(o, "%08X%08X%08X%08X\"\r\n", audit[0], audit[1], audit[2], audit[3]);
    }
    fclose(o);
  }
  return badParity ? 1 : 0;
}
