#pragma once

// scamp_async_shim.h
//
// Thin wrapper over std::async so the SCAMP core can be compiled either
// against a real threading runtime or in a strictly single-threaded
// environment (currently: single-threaded WebAssembly builds, where
// std::thread / std::async are unavailable when -pthread is off).
//
// Behaviour is identical to std::async(std::launch::async, ...) except
// when SCAMP_NO_ASYNC is defined, in which case the callable is invoked
// synchronously on the calling thread and a ready future is returned.

#include <functional>
#include <future>
#include <type_traits>
#include <utility>

namespace SCAMP {

#ifdef SCAMP_NO_ASYNC

template <typename F, typename... Args>
inline auto scamp_launch(F&& f, Args&&... args)
    -> std::future<typename std::invoke_result<F, Args...>::type> {
  using R = typename std::invoke_result<F, Args...>::type;
  std::promise<R> p;
  auto fut = p.get_future();
  if constexpr (std::is_void_v<R>) {
    std::invoke(std::forward<F>(f), std::forward<Args>(args)...);
    p.set_value();
  } else {
    p.set_value(std::invoke(std::forward<F>(f), std::forward<Args>(args)...));
  }
  return fut;
}

#else

template <typename F, typename... Args>
inline auto scamp_launch(F&& f, Args&&... args) {
  return std::async(std::launch::async, std::forward<F>(f),
                    std::forward<Args>(args)...);
}

#endif

}  // namespace SCAMP
