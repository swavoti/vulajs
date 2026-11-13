#include "vula_wasm.h"

#define VULA_HASH_SIZE 65536u
#define VULA_WINDOW_SIZE 4096u
#define VULA_MIN_MATCH 3u
#define VULA_MAX_MATCH 18u

static unsigned char input_buffer[VULA_COMPRESSED_CAPACITY];
static unsigned char output_buffer[VULA_COMPRESSED_CAPACITY];
static int last_position[VULA_HASH_SIZE];

unsigned int vula_compression_input_ptr(void) {
  return (unsigned int)(unsigned long)input_buffer;
}

unsigned int vula_compression_input_capacity(void) {
  return VULA_COMPRESSED_CAPACITY;
}

unsigned int vula_compression_output_ptr(void) {
  return (unsigned int)(unsigned long)output_buffer;
}

unsigned int vula_compression_output_capacity(void) {
  return VULA_COMPRESSED_CAPACITY;
}

static unsigned int hash_at(unsigned int position) {
  unsigned int hash = 0u;
  for (unsigned int i = 0; i < VULA_MIN_MATCH; i++) {
    hash = (hash * 251u + input_buffer[position + i]) & (VULA_HASH_SIZE - 1u);
  }
  return hash;
}

int vula_compress(unsigned int length) {
  if (length > VULA_COMPRESSION_CAPACITY) return -1;
  for (unsigned int i = 0; i < VULA_HASH_SIZE; i++) last_position[i] = -1;

  output_buffer[0] = 'V';
  output_buffer[1] = 'Z';
  output_buffer[2] = 'L';
  output_buffer[3] = '1';
  output_buffer[4] = (unsigned char)(length & 0xffu);
  output_buffer[5] = (unsigned char)((length >> 8) & 0xffu);
  output_buffer[6] = (unsigned char)((length >> 16) & 0xffu);
  output_buffer[7] = (unsigned char)((length >> 24) & 0xffu);

  unsigned int input_position = 0u;
  unsigned int output_position = 8u;
  while (input_position < length) {
    if (output_position >= VULA_COMPRESSED_CAPACITY) return -1;
    unsigned int control_position = output_position++;
    unsigned char control = 0u;

    for (unsigned int token = 0u; token < 8u && input_position < length; token++) {
      unsigned int best_length = 0u;
      unsigned int best_distance = 0u;
      if (input_position + VULA_MIN_MATCH <= length) {
        unsigned int hash = hash_at(input_position);
        int candidate = last_position[hash];
        last_position[hash] = (int)input_position;
        if (candidate >= 0) {
          unsigned int distance = input_position - (unsigned int)candidate;
          if (distance <= VULA_WINDOW_SIZE) {
            unsigned int limit = length - input_position;
            if (limit > VULA_MAX_MATCH) limit = VULA_MAX_MATCH;
            while (best_length < limit &&
                   input_buffer[(unsigned int)candidate + best_length] ==
                     input_buffer[input_position + best_length]) {
              best_length++;
            }
            if (best_length >= VULA_MIN_MATCH) best_distance = distance;
            else best_length = 0u;
          }
        }
      }

      if (best_length >= VULA_MIN_MATCH) {
        if (output_position + 2u > VULA_COMPRESSED_CAPACITY) return -1;
        control |= (unsigned char)(1u << token);
        unsigned int code = ((best_distance - 1u) << 4) | (best_length - VULA_MIN_MATCH);
        output_buffer[output_position++] = (unsigned char)(code & 0xffu);
        output_buffer[output_position++] = (unsigned char)((code >> 8) & 0xffu);

        for (unsigned int update = 1u; update < best_length; update++) {
          unsigned int position = input_position + update;
          if (position + VULA_MIN_MATCH <= length) {
            last_position[hash_at(position)] = (int)position;
          }
        }
        input_position += best_length;
      } else {
        if (output_position >= VULA_COMPRESSED_CAPACITY) return -1;
        output_buffer[output_position++] = input_buffer[input_position++];
      }
    }

    output_buffer[control_position] = control;
  }
  return (int)output_position;
}

int vula_decompress(unsigned int length) {
  if (length < 8u || length > VULA_COMPRESSED_CAPACITY ||
      input_buffer[0] != 'V' || input_buffer[1] != 'Z' ||
      input_buffer[2] != 'L' || input_buffer[3] != '1') return -1;

  unsigned int expected = (unsigned int)input_buffer[4] |
    ((unsigned int)input_buffer[5] << 8) |
    ((unsigned int)input_buffer[6] << 16) |
    ((unsigned int)input_buffer[7] << 24);
  if (expected > VULA_COMPRESSION_CAPACITY) return -1;

  unsigned int input_position = 8u;
  unsigned int output_position = 0u;
  while (output_position < expected) {
    if (input_position >= length) return -1;
    unsigned char control = input_buffer[input_position++];
    for (unsigned int token = 0u; token < 8u && output_position < expected; token++) {
      if (control & (1u << token)) {
        if (input_position + 2u > length) return -1;
        unsigned int code = (unsigned int)input_buffer[input_position] |
          ((unsigned int)input_buffer[input_position + 1u] << 8);
        input_position += 2u;
        unsigned int distance = (code >> 4) + 1u;
        unsigned int match_length = (code & 0x0fu) + VULA_MIN_MATCH;
        if (distance > output_position || output_position + match_length > expected) return -1;
        for (unsigned int i = 0u; i < match_length; i++) {
          output_buffer[output_position] = output_buffer[output_position - distance];
          output_position++;
        }
      } else {
        if (input_position >= length) return -1;
        output_buffer[output_position++] = input_buffer[input_position++];
      }
    }
  }
  if (input_position != length) return -1;
  return (int)output_position;
}
