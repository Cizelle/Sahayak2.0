if(NOT TARGET shopify_react-native-skia::rnskia)
add_library(shopify_react-native-skia::rnskia SHARED IMPORTED)
set_target_properties(shopify_react-native-skia::rnskia PROPERTIES
    IMPORTED_LOCATION "C:/Users/Zeltrax/Desktop/adaptivemesh/apps/mobile/node_modules/@shopify/react-native-skia/android/build/intermediates/cxx/Debug/2m6b4wf1/obj/x86/librnskia.so"
    INTERFACE_INCLUDE_DIRECTORIES "C:/Users/Zeltrax/Desktop/adaptivemesh/apps/mobile/node_modules/@shopify/react-native-skia/android/build/headers/rnskia"
    INTERFACE_LINK_LIBRARIES ""
)
endif()

