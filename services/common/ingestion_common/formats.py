"""Upload contract from reference backend application.properties (INGESTION).

Keep acceptance separate from geolocation: documents/media may have no map extent.
"""

REFERENCE_EXTENSIONS = tuple(
    "." + value
    for value in (
        "zip,tar,tif,tiff,ntf,ecw,jp2,geojson,mp4,mpg,mpeg,kml,kmz,png,jpg,jpeg,pdf,csv,"
        "grb,grb2,grib,grib2,nc,czml,nitf,las,laz,gpx,mbtiles,giq,giqreport,giqdrawing,giqcategories,dwg,xlsx,img"
    ).split(",")
)
SUPPORTED_EXTENSIONS = tuple(
    dict.fromkeys((*REFERENCE_EXTENSIONS, ".json", ".gpkg", ".shp"))
)
RASTER_EXTENSIONS = {
    ".tif",
    ".tiff",
    ".ntf",
    ".nitf",
    ".ecw",
    ".jp2",
    ".img",
    ".grb",
    ".grb2",
    ".grib",
    ".grib2",
    ".nc",
}
ARCHIVE_EXTENSIONS = {
    ".zip",
    ".tar",
    ".kmz",
    ".giq",
    ".giqreport",
    ".giqdrawing",
    ".giqcategories",
}
VECTOR_EXTENSIONS = {
    ".geojson",
    ".json",
    ".kml",
    ".gpkg",
    ".shp",
    ".csv",
    ".gpx",
    ".xlsx",
    ".dwg",
    ".czml",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}
VIDEO_EXTENSIONS = {".mp4", ".mpg", ".mpeg"}
