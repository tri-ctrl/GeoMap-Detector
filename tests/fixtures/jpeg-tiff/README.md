# Synthetic JPEG TIFF regressions

These files contain generated numeric/color patterns, not user imagery.

- `gray-gcps.tif`: 145 × 113 uint8 grayscale, JPEG tiles, 63 synthetic WGS84
  ground control points, and metadata larger than a fixed 1,000-byte TIFF header.
- `rgb-affine.tif`: 145 × 113 uint8 RGB, YCbCr JPEG tiles, synthetic WGS84
  affine georeferencing. Dimensions exercise partially filled edge tiles.

Generated using Rasterio/GDAL with 64 × 64 tiles and JPEG quality 90.
The ICEYE source file used for local verification remains outside the repository.
