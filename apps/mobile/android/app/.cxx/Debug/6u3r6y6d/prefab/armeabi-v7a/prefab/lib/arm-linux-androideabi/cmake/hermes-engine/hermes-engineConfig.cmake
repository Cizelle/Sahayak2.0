if(NOT TARGET hermes-engine::libhermes)
add_library(hermes-engine::libhermes SHARED IMPORTED)
set_target_properties(hermes-engine::libhermes PROPERTIES
    IMPORTED_LOCATION "C:/Users/Zeltrax/.gradle/caches/8.13/transforms/4fb53523ed49fdd1f54e3cbacff5a666/transformed/hermes-android-0.81.0-debug/prefab/modules/libhermes/libs/android.armeabi-v7a/libhermes.so"
    INTERFACE_INCLUDE_DIRECTORIES "C:/Users/Zeltrax/.gradle/caches/8.13/transforms/4fb53523ed49fdd1f54e3cbacff5a666/transformed/hermes-android-0.81.0-debug/prefab/modules/libhermes/include"
    INTERFACE_LINK_LIBRARIES ""
)
endif()

