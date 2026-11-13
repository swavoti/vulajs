#ifndef VULA_WASM_H
#define VULA_WASM_H

#define VULA_ROUTE_TABLE_CAPACITY (128u * 1024u)
#define VULA_PATH_CAPACITY (16u * 1024u)
#define VULA_COMPRESSION_CAPACITY (256u * 1024u)
#define VULA_COMPRESSED_CAPACITY (VULA_COMPRESSION_CAPACITY + VULA_COMPRESSION_CAPACITY / 8u + 16u)

unsigned int vula_route_table_ptr(void);
unsigned int vula_route_table_capacity(void);
unsigned int vula_path_ptr(void);
unsigned int vula_path_capacity(void);
int vula_init_routes(unsigned int length);
int vula_match_path(unsigned int length);

unsigned int vula_compression_input_ptr(void);
unsigned int vula_compression_input_capacity(void);
unsigned int vula_compression_output_ptr(void);
unsigned int vula_compression_output_capacity(void);
int vula_compress(unsigned int length);
int vula_decompress(unsigned int length);

#endif
