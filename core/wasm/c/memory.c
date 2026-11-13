void *memset(void *destination, int value, unsigned int length) {
  volatile unsigned char *bytes = (volatile unsigned char *)destination;
  for (unsigned int i = 0; i < length; i++) bytes[i] = (unsigned char)value;
  return destination;
}

void *memcpy(void *destination, const void *source, unsigned int length) {
  volatile unsigned char *output = (volatile unsigned char *)destination;
  const volatile unsigned char *input = (const volatile unsigned char *)source;
  for (unsigned int i = 0; i < length; i++) output[i] = input[i];
  return destination;
}
