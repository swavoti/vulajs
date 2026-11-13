#include "vula_wasm.h"

#define VULA_MAX_ROUTE_NODES 8192u
#define VULA_MAX_SEGMENT_LENGTH 255u
#define VULA_MAX_ROUTE_DEPTH 128u
#define VULA_NO_NODE 0xffffffffu
#define VULA_STATIC 0u
#define VULA_DYNAMIC 1u
#define VULA_WILDCARD 2u

typedef struct {
  unsigned int first_child;
  unsigned int next_sibling;
  int route_index;
  unsigned int label_offset;
  unsigned short label_length;
  unsigned char kind;
} RouteNode;

static unsigned char route_table[VULA_ROUTE_TABLE_CAPACITY];
static unsigned char path_buffer[VULA_PATH_CAPACITY];
static RouteNode nodes[VULA_MAX_ROUTE_NODES];
static unsigned int node_count;
static int routes_ready;

static unsigned char fold_ascii(unsigned char value) {
  if (value >= 'A' && value <= 'Z') return (unsigned char)(value + ('a' - 'A'));
  return value;
}

unsigned int vula_route_table_ptr(void) {
  return (unsigned int)(unsigned long)route_table;
}

unsigned int vula_route_table_capacity(void) {
  return VULA_ROUTE_TABLE_CAPACITY;
}

unsigned int vula_path_ptr(void) {
  return (unsigned int)(unsigned long)path_buffer;
}

unsigned int vula_path_capacity(void) {
  return VULA_PATH_CAPACITY;
}

static int segment_equals(const RouteNode *node, const unsigned char *text, unsigned int length) {
  if (node->label_length != length) return 0;
  for (unsigned int i = 0; i < length; i++) {
    if (fold_ascii(route_table[node->label_offset + i]) != fold_ascii(text[i])) return 0;
  }
  return 1;
}

static unsigned int find_child(unsigned int parent, unsigned char kind, const unsigned char *text, unsigned int length) {
  unsigned int child = nodes[parent].first_child;
  while (child != VULA_NO_NODE) {
    RouteNode *candidate = &nodes[child];
    if (candidate->kind == kind &&
        (kind != VULA_STATIC || segment_equals(candidate, text, length))) {
      return child;
    }
    child = candidate->next_sibling;
  }
  return VULA_NO_NODE;
}

static unsigned int add_child(unsigned int parent, unsigned char kind, unsigned int offset, unsigned int length) {
  if (node_count >= VULA_MAX_ROUTE_NODES) return VULA_NO_NODE;
  unsigned int index = node_count++;
  nodes[index].first_child = VULA_NO_NODE;
  nodes[index].next_sibling = nodes[parent].first_child;
  nodes[index].route_index = -1;
  nodes[index].label_offset = offset;
  nodes[index].label_length = (unsigned short)length;
  nodes[index].kind = kind;
  nodes[parent].first_child = index;
  return index;
}

int vula_init_routes(unsigned int length) {
  routes_ready = 0;
  if (length > VULA_ROUTE_TABLE_CAPACITY) return -1;
  for (unsigned int i = 0; i < VULA_MAX_ROUTE_NODES; i++) {
    nodes[i].first_child = VULA_NO_NODE;
    nodes[i].next_sibling = VULA_NO_NODE;
    nodes[i].route_index = -1;
  }
  node_count = 1u;
  nodes[0].first_child = VULA_NO_NODE;
  nodes[0].next_sibling = VULA_NO_NODE;
  nodes[0].route_index = -1;
  nodes[0].label_offset = 0u;
  nodes[0].label_length = 0u;
  nodes[0].kind = VULA_STATIC;

  unsigned int route_index = 0u;
  unsigned int line_start = 0u;
  while (line_start < length) {
    unsigned int line_end = line_start;
    while (line_end < length && route_table[line_end] != '\n') line_end++;
    if (line_end == line_start) return -1;

    unsigned int current = 0u;
    unsigned int cursor = line_start;
    unsigned int depth = 0u;
    while (cursor < line_end && route_table[cursor] == '/') cursor++;
    while (cursor < line_end) {
      unsigned int segment_start = cursor;
      while (cursor < line_end && route_table[cursor] != '/') cursor++;
      unsigned int segment_length = cursor - segment_start;
      if (segment_length == 0u) {
        while (cursor < line_end && route_table[cursor] == '/') cursor++;
        continue;
      }
      if (++depth > VULA_MAX_ROUTE_DEPTH) return -1;

      unsigned char kind = VULA_STATIC;
      unsigned int label_offset = segment_start;
      unsigned int label_length = segment_length;
      if (route_table[segment_start] == ':') {
        kind = VULA_DYNAMIC;
        label_offset++;
        label_length--;
      } else if (route_table[segment_start] == '*') {
        kind = VULA_WILDCARD;
        label_offset++;
        label_length--;
      }
      if (label_length == 0u || label_length > VULA_MAX_SEGMENT_LENGTH) return -1;

      unsigned int child = find_child(current, kind, route_table + label_offset, label_length);
      if (child == VULA_NO_NODE) {
        child = add_child(current, kind, label_offset, label_length);
        if (child == VULA_NO_NODE) return -1;
      }
      current = child;
      while (cursor < line_end && route_table[cursor] == '/') cursor++;
    }

    if (nodes[current].route_index >= 0) return -1;
    nodes[current].route_index = (int)route_index;
    route_index++;
    line_start = line_end + 1u;
  }

  routes_ready = 1;
  return (int)route_index;
}

static int match_from(unsigned int node_index, unsigned int path_length, unsigned int cursor) {
  if (cursor >= path_length) return nodes[node_index].route_index;

  unsigned int segment_start = cursor;
  while (cursor < path_length && path_buffer[cursor] != '/') cursor++;
  unsigned int segment_length = cursor - segment_start;
  unsigned int next = cursor < path_length ? cursor + 1u : path_length;

  unsigned int child = nodes[node_index].first_child;
  while (child != VULA_NO_NODE) {
    if (nodes[child].kind == VULA_STATIC &&
        segment_equals(&nodes[child], path_buffer + segment_start, segment_length)) {
      int result = match_from(child, path_length, next);
      if (result >= 0) return result;
    }
    child = nodes[child].next_sibling;
  }

  child = nodes[node_index].first_child;
  while (child != VULA_NO_NODE) {
    if (nodes[child].kind == VULA_DYNAMIC) {
      int result = match_from(child, path_length, next);
      if (result >= 0) return result;
    }
    child = nodes[child].next_sibling;
  }

  child = nodes[node_index].first_child;
  while (child != VULA_NO_NODE) {
    if (nodes[child].kind == VULA_WILDCARD && nodes[child].route_index >= 0) {
      return nodes[child].route_index;
    }
    child = nodes[child].next_sibling;
  }
  return -1;
}

int vula_match_path(unsigned int length) {
  if (!routes_ready || length > VULA_PATH_CAPACITY) return -1;
  unsigned int cursor = 0u;
  while (cursor < length && path_buffer[cursor] == '/') cursor++;
  while (length > cursor && path_buffer[length - 1u] == '/') length--;
  if (cursor >= length) return nodes[0].route_index;
  unsigned int depth = 1u;
  for (unsigned int i = cursor; i < length; i++) {
    if (path_buffer[i] == '/' && ++depth > VULA_MAX_ROUTE_DEPTH) return -1;
  }
  return match_from(0u, length, cursor);
}
